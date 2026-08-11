import * as https from "node:https";
import type { IncomingMessage, RequestOptions } from "node:http";
import { type UpdateCache, type UpdateInfo } from "./contracts";
import { boundedString, plainRecord } from "./validation";

const RELEASE_API = new URL(
  "https://api.github.com/repos/MiniLuv-Skunk-Works/miniluv-intel-viewer/releases/latest",
);
const RELEASE_ORIGIN = "https://github.com";
const RELEASE_PATH_PREFIX = "/MiniLuv-Skunk-Works/miniluv-intel-viewer/releases/";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 128 * 1_024;

type RequestFactory = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ReturnType<typeof https.request>;

export interface UpdateCheckerOptions {
  currentVersion: string;
  getCache(): UpdateCache | undefined;
  saveCache(cache: UpdateCache): Promise<void> | void;
  onUpdate(info: UpdateInfo): void;
  onError(): void;
  request?: RequestFactory;
  now?: () => number;
}

interface StableRelease {
  version: string;
  title: string;
  notes: string;
  publishedAt: string;
  releaseUrl: string;
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? (parts as [number, number, number]) : null;
}

export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

export function allowedReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === RELEASE_ORIGIN &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.startsWith(RELEASE_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}

function parseRelease(value: unknown): StableRelease | null {
  const source = plainRecord(value);
  if (!source || source.draft === true || source.prerelease === true) return null;
  const tag = boundedString(source.tag_name, 64, 1);
  const version = tag?.replace(/^v/, "") ?? null;
  const titleValue = source.name === null ? "" : boundedString(source.name, 256);
  const notesValue = source.body === null ? "" : boundedString(source.body, 16_384);
  const publishedAt = boundedString(source.published_at, 64);
  const releaseUrl = boundedString(source.html_url, 2_048, 1);
  if (
    !version ||
    !parseVersion(version) ||
    titleValue === null ||
    notesValue === null ||
    publishedAt === null ||
    !releaseUrl ||
    !allowedReleaseUrl(releaseUrl)
  ) {
    return null;
  }
  return {
    version,
    title: titleValue || "MILF Viewer " + version,
    notes: notesValue,
    publishedAt,
    releaseUrl,
  };
}

export class UpdateChecker {
  private readonly options: UpdateCheckerOptions;
  private readonly requestFactory: RequestFactory;
  private readonly now: () => number;
  private activeRequest: ReturnType<typeof https.request> | null = null;
  private inFlight: Promise<UpdateInfo> | null = null;

  constructor(options: UpdateCheckerOptions) {
    this.options = options;
    this.requestFactory = options.request ?? https.request;
    this.now = options.now ?? Date.now;
  }

  cachedInfo(): UpdateInfo {
    return this.infoFromCache(this.options.getCache(), "unknown");
  }

  check(force = false): Promise<UpdateInfo> {
    if (this.inFlight) return this.inFlight;
    const cache = this.options.getCache();
    if (!force && cache && this.now() - cache.checkedAt < CHECK_INTERVAL_MS) {
      const info = this.infoFromCache(cache, "up-to-date");
      this.options.onUpdate(info);
      return Promise.resolve(info);
    }
    this.options.onUpdate({ status: "checking", currentVersion: this.options.currentVersion });
    const check = this.fetchRelease()
      .then(async (release) => {
        const cache: UpdateCache = { checkedAt: this.now(), release };
        await this.options.saveCache(cache);
        const info = this.infoFromCache(cache, "up-to-date");
        this.options.onUpdate(info);
        return info;
      })
      .catch(async () => {
        const attempted: UpdateCache = {
          checkedAt: this.now(),
          release: this.options.getCache()?.release ?? null,
        };
        await this.options.saveCache(attempted);
        this.options.onError();
        const info: UpdateInfo = {
          status: "error",
          currentVersion: this.options.currentVersion,
          checkedAt: attempted.checkedAt,
          error: "Could not check for a newer release. Try again later.",
        };
        this.options.onUpdate(info);
        return info;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = check;
    return check;
  }

  cancel(): void {
    this.activeRequest?.destroy();
    this.activeRequest = null;
  }

  private infoFromCache(
    cache: UpdateCache | undefined,
    emptyStatus: UpdateInfo["status"],
  ): UpdateInfo {
    if (!cache?.release) {
      return {
        status: emptyStatus,
        currentVersion: this.options.currentVersion,
        ...(cache ? { checkedAt: cache.checkedAt } : {}),
      };
    }
    const comparison = compareVersions(this.options.currentVersion, cache.release.version);
    return {
      status: comparison !== null && comparison < 0 ? "available" : "up-to-date",
      currentVersion: this.options.currentVersion,
      latestVersion: cache.release.version,
      title: cache.release.title,
      notes: cache.release.notes,
      publishedAt: cache.release.publishedAt,
      releaseUrl: cache.release.releaseUrl,
      checkedAt: cache.checkedAt,
    };
  }

  private fetchRelease(): Promise<StableRelease> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let response: IncomingMessage | null = null;
      let connectionTimer: NodeJS.Timeout | null = null;
      let responseTimer: NodeJS.Timeout | null = null;
      const finish = (error: Error | null, release?: StableRelease): void => {
        if (settled) return;
        settled = true;
        if (connectionTimer) clearTimeout(connectionTimer);
        if (responseTimer) clearTimeout(responseTimer);
        this.activeRequest = null;
        if (error || !release) reject(error ?? new Error("invalid release"));
        else resolve(release);
      };
      const request = this.requestFactory(
        RELEASE_API,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "MILF-Viewer/" + this.options.currentVersion,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
        (incoming) => {
          response = incoming;
          if (connectionTimer) clearTimeout(connectionTimer);
          responseTimer = setTimeout(() => {
            incoming.destroy();
            finish(new Error("release response timeout"));
          }, 20_000);
          if (incoming.statusCode !== 200) {
            incoming.resume();
            finish(new Error("release response status"));
            return;
          }
          const contentType = String(incoming.headers["content-type"] ?? "")
            .split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
            incoming.resume();
            finish(new Error("release response content type"));
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          incoming.on("data", (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += bytes.length;
            if (received > MAX_RESPONSE_BYTES) {
              incoming.destroy();
              finish(new Error("release response too large"));
            } else chunks.push(bytes);
          });
          incoming.once("end", () => {
            try {
              const release = parseRelease(
                JSON.parse(Buffer.concat(chunks, received).toString("utf8")),
              );
              finish(release ? null : new Error("invalid release response"), release ?? undefined);
            } catch {
              finish(new Error("malformed release response"));
            }
          });
          incoming.once("error", () => finish(new Error("release connection closed")));
        },
      );
      this.activeRequest = request;
      connectionTimer = setTimeout(() => {
        request.destroy();
        response?.destroy();
        finish(new Error("release connection timeout"));
      }, 10_000);
      request.once("error", () => finish(new Error("release connection failed")));
      request.end();
    });
  }
}
