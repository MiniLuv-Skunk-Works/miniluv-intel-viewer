import * as http from "node:http";
import * as https from "node:https";

export interface FeedSession {
  serverUrl: string;
  token: string;
}

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export type FeedConnectionStatus =
  | { state: "connecting" | "live" | "stale" }
  | { state: "reconnecting" | "offline" | "error"; detail: string };

export interface FeedConnectionCallbacks {
  onStatus(status: FeedConnectionStatus): void;
  onEvent(message: SseMessage): boolean | void;
  onUnauthorized(): void;
}

type Timer = ReturnType<typeof setTimeout>;
type RequestFactory = (
  url: URL,
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
) => http.ClientRequest;

export interface FeedConnectionOptions extends FeedConnectionCallbacks {
  connectionTimeoutMs?: number;
  responseTimeoutMs?: number;
  idleTimeoutMs?: number;
  staleTimeoutMs?: number;
  maxFrameBytes?: number;
  minimumRetryMs?: number;
  maximumRetryMs?: number;
  random?: () => number;
  request?: RequestFactory;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_STALE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MINIMUM_RETRY_MS = 1_000;
const DEFAULT_MAXIMUM_RETRY_MS = 30_000;
const MAX_SEEN_SCAN_IDS = 1_024;

function defaultRequest(
  url: URL,
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
): http.ClientRequest {
  return (url.protocol === "https:" ? https : http).request(url, options, callback);
}

function eventStreamContentType(value: string | undefined): boolean {
  return (value?.split(";", 1)[0]?.trim().toLowerCase() ?? "") === "text/event-stream";
}

function transmissibleHeaderValue(value: string): boolean {
  // Node rejects control characters and code points above Latin-1 in outgoing
  // HTTP/1 headers. Retaining the previous safe cursor requests a slightly
  // wider replay without corrupting a Unicode ID or entering a retry loop.
  return /^[\t\x20-\x7e\x80-\xff]+$/.test(value);
}

export class SseFrameTooLargeError extends Error {
  constructor() {
    super("SSE frame exceeded the allowed size");
    this.name = "SseFrameTooLargeError";
  }
}

export class SseParser {
  private buffer = "";
  private event = "";
  private id: string | undefined;
  private readonly data: string[] = [];
  private frameBytes = 0;

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.frameBytes += Buffer.byteLength(line) + 1;
      if (this.frameBytes > this.maxFrameBytes) throw new SseFrameTooLargeError();

      if (line === "") {
        if (this.data.length > 0) {
          messages.push({
            event: this.event || "message",
            data: this.data.join("\n"),
            ...(this.id === undefined ? {} : { id: this.id }),
          });
        }
        this.event = "";
        this.id = undefined;
        this.data.length = 0;
        this.frameBytes = 0;
        continue;
      }
      if (line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
      else if (field === "id" && !value.includes("\0")) this.id = value;
    }

    if (this.frameBytes + Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
      throw new SseFrameTooLargeError();
    }
    return messages;
  }
}

export class FeedConnectionManager {
  private readonly callbacks: FeedConnectionCallbacks;
  private readonly connectionTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly staleTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly minimumRetryMs: number;
  private readonly maximumRetryMs: number;
  private readonly random: () => number;
  private readonly requestFactory: RequestFactory;
  private readonly setTimer: (callback: () => void, delay: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;

  private generation = 0;
  private session: FeedSession | null = null;
  private request: http.ClientRequest | null = null;
  private response: http.IncomingMessage | null = null;
  private retryTimer: Timer | null = null;
  private connectionTimer: Timer | null = null;
  private responseTimer: Timer | null = null;
  private idleTimer: Timer | null = null;
  private staleTimer: Timer | null = null;
  private retryMs: number;
  private replayEnabled = false;
  private lastEventId: string | null = null;
  private readonly seenScanIds = new Set<string>();
  private readonly seenScanIdOrder: string[] = [];

  constructor(options: FeedConnectionOptions) {
    this.callbacks = options;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.minimumRetryMs = options.minimumRetryMs ?? DEFAULT_MINIMUM_RETRY_MS;
    this.maximumRetryMs = options.maximumRetryMs ?? DEFAULT_MAXIMUM_RETRY_MS;
    this.retryMs = this.minimumRetryMs;
    this.random = options.random ?? Math.random;
    this.requestFactory = options.request ?? defaultRequest;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  start(session: FeedSession): void {
    this.generation += 1;
    this.clearAll();
    this.session = { ...session };
    this.retryMs = this.minimumRetryMs;
    this.resetReplay();
    this.connect(this.generation);
  }

  stop(): void {
    this.generation += 1;
    this.session = null;
    this.clearAll();
    this.retryMs = this.minimumRetryMs;
    this.resetReplay();
  }

  setReplayEnabled(enabled: boolean): void {
    this.replayEnabled = enabled;
    if (!enabled) {
      this.lastEventId = null;
      this.seenScanIds.clear();
      this.seenScanIdOrder.length = 0;
    }
  }

  private current(generation: number): boolean {
    return generation === this.generation && this.session !== null;
  }

  private connect(generation: number): void {
    if (!this.current(generation) || !this.session || this.request) return;
    const session = this.session;
    const target = new URL("/api/feed", session.serverUrl);
    const parser = new SseParser(this.maxFrameBytes);
    let active = false;
    let stale = false;
    this.callbacks.onStatus({ state: "connecting" });

    const armResponseTimer = (): void => {
      if (!this.current(generation) || this.responseTimer) return;
      this.clearConnectionTimer();
      this.responseTimer = this.setTimer(() => {
        if (!this.current(generation)) return;
        this.callbacks.onStatus({ state: "offline", detail: "feed response timed out" });
        this.scheduleRetry(generation);
      }, this.responseTimeoutMs);
    };

    let req: http.ClientRequest;
    const headers: Record<string, string> = {
      Authorization: "Bearer " + session.token,
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    };
    if (this.replayEnabled && this.lastEventId) headers["Last-Event-ID"] = this.lastEventId;

    try {
      req = this.requestFactory(
        target,
        {
          method: "GET",
          headers,
        },
        (res) => {
          if (!this.current(generation) || req !== this.request) {
            res.destroy();
            return;
          }
          this.response = res;
          this.clearConnectionTimer();
          this.clearResponseTimer();
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            res.resume();
            this.terminate(generation);
            this.callbacks.onUnauthorized();
            return;
          }
          if (status !== 200) {
            res.resume();
            this.callbacks.onStatus({ state: "error", detail: "server returned " + status });
            this.scheduleRetry(generation);
            return;
          }
          if (!eventStreamContentType(res.headers["content-type"])) {
            res.resume();
            this.callbacks.onStatus({ state: "error", detail: "server returned a non-SSE feed" });
            this.scheduleRetry(generation);
            return;
          }

          this.callbacks.onStatus({ state: "live" });
          res.setEncoding("utf8");
          const armActivityTimers = (): void => {
            if (stale) {
              stale = false;
              this.callbacks.onStatus({ state: "live" });
            }
            this.armIdleTimer(generation, () => {
              stale = true;
            });
          };
          armActivityTimers();
          res.on("data", (chunk: string) => {
            if (!this.current(generation) || res !== this.response) return;
            if (!active) {
              active = true;
              this.retryMs = this.minimumRetryMs;
            }
            armActivityTimers();
            try {
              for (const message of parser.push(chunk)) {
                if (
                  message.event === "scan" &&
                  this.replayEnabled &&
                  message.id &&
                  this.seenScanIds.has(message.id)
                )
                  continue;
                const accepted = this.callbacks.onEvent(message);
                if (
                  message.event === "scan" &&
                  this.replayEnabled &&
                  message.id &&
                  accepted !== false
                ) {
                  this.acceptScanId(message.id);
                }
              }
            } catch (error) {
              const detail =
                error instanceof SseFrameTooLargeError
                  ? "feed event exceeded the allowed size"
                  : "feed stream was invalid";
              this.callbacks.onStatus({ state: "offline", detail });
              this.scheduleRetry(generation);
            }
          });
          res.once("end", () => this.scheduleRetry(generation));
          res.on("error", () => this.scheduleRetry(generation));
          res.once("aborted", () => this.scheduleRetry(generation));
        },
      );
    } catch {
      this.callbacks.onStatus({ state: "offline", detail: "feed request could not be started" });
      this.scheduleRetry(generation);
      return;
    }

    this.request = req;
    this.connectionTimer = this.setTimer(() => {
      if (!this.current(generation)) return;
      this.callbacks.onStatus({ state: "offline", detail: "feed connection timed out" });
      this.scheduleRetry(generation);
    }, this.connectionTimeoutMs);
    req.once("socket", (socket) => {
      if (!socket.connecting) {
        armResponseTimer();
        return;
      }
      const event = target.protocol === "https:" ? "secureConnect" : "connect";
      socket.once(event, armResponseTimer);
    });
    req.on("error", () => {
      if (!this.current(generation)) return;
      this.callbacks.onStatus({ state: "offline", detail: "could not connect to dashboard" });
      this.scheduleRetry(generation);
    });
    req.end();
  }

  private scheduleRetry(generation: number): void {
    if (!this.current(generation) || this.retryTimer) return;
    const nominal = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.maximumRetryMs);
    const delay = Math.round(nominal * (0.5 + Math.max(0, Math.min(1, this.random())) * 0.5));
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.current(generation)) this.connect(generation);
    }, delay);
    this.clearConnection();
    this.callbacks.onStatus({
      state: "reconnecting",
      detail: Math.max(1, Math.round(delay / 1_000)) + "s",
    });
  }

  private armIdleTimer(generation: number, onStale: () => void): void {
    if (this.staleTimer) this.clearTimer(this.staleTimer);
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    this.staleTimer = this.setTimer(() => {
      if (!this.current(generation)) return;
      onStale();
      this.callbacks.onStatus({ state: "stale" });
    }, this.staleTimeoutMs);
    this.idleTimer = this.setTimer(() => {
      if (!this.current(generation)) return;
      this.callbacks.onStatus({ state: "offline", detail: "feed idle timeout" });
      this.scheduleRetry(generation);
    }, this.idleTimeoutMs);
  }

  private terminate(generation: number): void {
    if (!this.current(generation)) return;
    this.generation += 1;
    this.session = null;
    this.clearAll();
  }

  private clearConnectionTimer(): void {
    if (this.connectionTimer) this.clearTimer(this.connectionTimer);
    this.connectionTimer = null;
  }

  private clearResponseTimer(): void {
    if (this.responseTimer) this.clearTimer(this.responseTimer);
    this.responseTimer = null;
  }

  private clearConnection(): void {
    this.clearConnectionTimer();
    this.clearResponseTimer();
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    if (this.staleTimer) this.clearTimer(this.staleTimer);
    this.idleTimer = null;
    this.staleTimer = null;
    const response = this.response;
    const request = this.request;
    this.response = null;
    this.request = null;
    response?.destroy();
    request?.destroy();
  }

  private clearAll(): void {
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.clearConnection();
  }

  private acceptScanId(id: string): void {
    if (transmissibleHeaderValue(id)) this.lastEventId = id;
    if (this.seenScanIds.has(id)) return;
    this.seenScanIds.add(id);
    this.seenScanIdOrder.push(id);
    if (this.seenScanIdOrder.length > MAX_SEEN_SCAN_IDS) {
      const oldest = this.seenScanIdOrder.shift();
      if (oldest !== undefined) this.seenScanIds.delete(oldest);
    }
  }

  private resetReplay(): void {
    this.replayEnabled = false;
    this.lastEventId = null;
    this.seenScanIds.clear();
    this.seenScanIdOrder.length = 0;
  }
}
