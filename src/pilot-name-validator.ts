import * as https from "node:https";
import type { ClientRequest } from "node:http";
import { plausibleCharacterName } from "./clipboard-filter";

const ESI_UNIVERSE_IDS = new URL(
  "https://esi.evetech.net/latest/universe/ids/?datasource=tranquility",
);
const MAX_RESPONSE_BYTES = 32 * 1024;
const CONNECTION_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 5_000;
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1_000;
const NEGATIVE_TTL_MS = 10 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 512;
const MIN_LOOKUP_INTERVAL_MS = 1_000;

export interface PilotNameHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

export interface PilotNameHttpClient {
  lookup(candidate: string): Promise<PilotNameHttpResponse | null>;
}

export interface PilotNameClock {
  now(): number;
  sleep(delayMs: number): Promise<void>;
}

export interface PilotNameValidation {
  validate(candidate: string): Promise<string | null>;
}

interface CacheEntry {
  readonly canonicalName: string | null;
  readonly expiresAt: number;
}

const systemClock: PilotNameClock = {
  now: Date.now,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

export class EsiPilotNameHttpClient implements PilotNameHttpClient {
  private readonly userAgent: string;

  constructor(appVersion: string) {
    this.userAgent = `MILF-Viewer/${appVersion}`;
  }

  lookup(candidate: string): Promise<PilotNameHttpResponse | null> {
    const serialized = JSON.stringify([candidate]);
    return new Promise((resolve) => {
      let settled = false;
      let connectionTimer: NodeJS.Timeout | null = null;
      let responseTimer: NodeJS.Timeout | null = null;
      let request: ClientRequest;

      const finish = (result: PilotNameHttpResponse | null, destroy = false): void => {
        if (settled) return;
        settled = true;
        if (connectionTimer) clearTimeout(connectionTimer);
        if (responseTimer) clearTimeout(responseTimer);
        if (destroy) request.destroy();
        resolve(result);
      };

      try {
        request = https.request(
          ESI_UNIVERSE_IDS,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(serialized),
              "User-Agent": this.userAgent,
            },
          },
          (response) => {
            if (connectionTimer) clearTimeout(connectionTimer);
            connectionTimer = null;
            responseTimer = setTimeout(() => finish(null, true), RESPONSE_TIMEOUT_MS);
            const chunks: Buffer[] = [];
            let received = 0;
            response.on("data", (chunk: Buffer | string) => {
              if (settled) return;
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              received += bytes.length;
              if (received > MAX_RESPONSE_BYTES) {
                response.destroy();
                finish(null, true);
                return;
              }
              chunks.push(bytes);
            });
            response.once("error", () => finish(null, true));
            response.once("aborted", () => finish(null, true));
            response.once("end", () => {
              if (settled) return;
              let body: unknown;
              try {
                body = JSON.parse(Buffer.concat(chunks, received).toString("utf8"));
              } catch {
                finish(null);
                return;
              }
              const header = (name: string): string | undefined => {
                const value = response.headers[name];
                return Array.isArray(value) ? value[0] : value;
              };
              finish({
                status: response.statusCode ?? 0,
                headers: {
                  "x-esi-error-limit-remain": header("x-esi-error-limit-remain"),
                  "x-esi-error-limit-reset": header("x-esi-error-limit-reset"),
                },
                body,
              });
            });
          },
        );
      } catch {
        resolve(null);
        return;
      }

      connectionTimer = setTimeout(() => finish(null, true), CONNECTION_TIMEOUT_MS);
      request.once("error", () => finish(null));
      request.write(serialized);
      request.end();
    });
  }
}

export class PilotNameValidator implements PilotNameValidation {
  private readonly http: PilotNameHttpClient;
  private readonly clock: PilotNameClock;
  private readonly cache = new Map<string, CacheEntry>();
  private queue: Promise<void> = Promise.resolve();
  private lastLookupStartedAt = Number.NEGATIVE_INFINITY;
  private disabledUntil = 0;

  constructor(http: PilotNameHttpClient, clock: PilotNameClock = systemClock) {
    this.http = http;
    this.clock = clock;
  }

  validate(candidate: string): Promise<string | null> {
    const plausible = plausibleCharacterName(candidate);
    if (!plausible) return Promise.resolve(null);
    candidate = plausible;
    const key = candidate.toLowerCase();
    const cached = this.cached(key);
    if (cached !== undefined) return Promise.resolve(cached);

    let resolveResult: (result: string | null) => void = () => undefined;
    const result = new Promise<string | null>((resolve) => {
      resolveResult = resolve;
    });
    this.queue = this.queue
      .then(async () => {
        const queuedCache = this.cached(key);
        if (queuedCache !== undefined) {
          resolveResult(queuedCache);
          return;
        }
        const now = this.clock.now();
        if (now < this.disabledUntil) {
          resolveResult(null);
          return;
        }
        const wait = this.lastLookupStartedAt + MIN_LOOKUP_INTERVAL_MS - now;
        if (wait > 0) await this.clock.sleep(wait);
        if (this.clock.now() < this.disabledUntil) {
          resolveResult(null);
          return;
        }
        this.lastLookupStartedAt = this.clock.now();
        const response = await this.http.lookup(candidate);
        this.applyErrorLimit(response);
        const canonicalName = this.exactCharacterMatch(candidate, response);
        this.remember(key, canonicalName);
        resolveResult(canonicalName);
      })
      .catch(() => resolveResult(null));
    return result;
  }

  private cached(key: string): string | null | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.canonicalName;
  }

  private remember(key: string, canonicalName: string | null): void {
    this.cache.delete(key);
    this.cache.set(key, {
      canonicalName,
      expiresAt: this.clock.now() + (canonicalName === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS),
    });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private applyErrorLimit(response: PilotNameHttpResponse | null): void {
    if (!response) return;
    const remaining = Number(response.headers["x-esi-error-limit-remain"]);
    const resetSeconds = Number(response.headers["x-esi-error-limit-reset"]);
    if (
      Number.isFinite(remaining) &&
      remaining <= 0 &&
      Number.isFinite(resetSeconds) &&
      resetSeconds > 0
    ) {
      this.disabledUntil = Math.max(this.disabledUntil, this.clock.now() + resetSeconds * 1_000);
    }
  }

  private exactCharacterMatch(
    candidate: string,
    response: PilotNameHttpResponse | null,
  ): string | null {
    if (!response || response.status < 200 || response.status >= 300) return null;
    if (!response.body || typeof response.body !== "object" || Array.isArray(response.body)) {
      return null;
    }
    const characters = (response.body as { readonly characters?: unknown }).characters;
    if (!Array.isArray(characters) || characters.length > 100) return null;
    const expected = candidate.trim().toLowerCase();
    for (const character of characters) {
      if (!character || typeof character !== "object" || Array.isArray(character)) continue;
      const rawName = (character as { readonly name?: unknown }).name;
      const canonicalName = plausibleCharacterName(rawName);
      if (canonicalName && canonicalName.toLowerCase() === expected) return canonicalName;
    }
    return null;
  }
}
