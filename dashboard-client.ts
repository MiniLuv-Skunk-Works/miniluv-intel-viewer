import * as http from "node:http";
import * as https from "node:https";

export type DashboardRequestErrorKind =
  | "http"
  | "connection"
  | "timeout"
  | "response-too-large"
  | "content-type"
  | "malformed-json"
  | "invalid-response"
  | "cancelled";

export interface DashboardRequestSuccess<T> {
  ok: true;
  status: number;
  body: T;
}

export interface DashboardRequestFailure {
  ok: false;
  kind: DashboardRequestErrorKind;
  message: string;
  status?: number;
  body?: unknown;
}

export type DashboardRequestResult<T> = DashboardRequestSuccess<T> | DashboardRequestFailure;

export interface DashboardJsonRequest<T> {
  url: URL;
  method: "GET" | "POST";
  parse: (value: unknown) => T | null;
  token?: string;
  body?: unknown;
  maxResponseBytes?: number;
  responseTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface DashboardClientOptions {
  connectionTimeoutMs?: number;
  responseTimeoutMs?: number;
  maxResponseBytes?: number;
  request?: RequestFactory;
}

type RequestFactory = (
  url: URL,
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
) => http.ClientRequest;

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

function defaultRequest(
  url: URL,
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
): http.ClientRequest {
  return (url.protocol === "https:" ? https : http).request(url, options, callback);
}

function jsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mime === "application/json" || (mime.startsWith("application/") && mime.endsWith("+json"));
}

function failure(
  kind: DashboardRequestErrorKind,
  message: string,
  status?: number,
  body?: unknown,
): DashboardRequestFailure {
  return {
    ok: false,
    kind,
    message,
    ...(status === undefined ? {} : { status }),
    ...(body === undefined ? {} : { body }),
  };
}

export class DashboardClient {
  private readonly connectionTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly requestFactory: RequestFactory;
  private readonly cancellations = new Map<http.ClientRequest, () => void>();

  constructor(options: DashboardClientOptions = {}) {
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.requestFactory = options.request ?? defaultRequest;
  }

  cancelAll(): void {
    for (const cancel of [...this.cancellations.values()]) cancel();
  }

  requestJson<T>(request: DashboardJsonRequest<T>): Promise<DashboardRequestResult<T>> {
    if (request.signal?.aborted) {
      return Promise.resolve(failure("cancelled", "Dashboard request was cancelled."));
    }

    let serializedBody: string | undefined;
    try {
      if (request.body !== undefined) serializedBody = JSON.stringify(request.body);
    } catch {
      return Promise.resolve(
        failure("invalid-response", "Dashboard request could not be encoded."),
      );
    }

    const maxResponseBytes = request.maxResponseBytes ?? this.maxResponseBytes;
    const responseTimeoutMs = request.responseTimeoutMs ?? this.responseTimeoutMs;

    return new Promise((resolve) => {
      let settled = false;
      let connectionTimer: NodeJS.Timeout | null = null;
      let responseTimer: NodeJS.Timeout | null = null;
      let response: http.IncomingMessage | null = null;
      let req: http.ClientRequest;

      const clearTimers = (): void => {
        if (connectionTimer) clearTimeout(connectionTimer);
        if (responseTimer) clearTimeout(responseTimer);
        connectionTimer = null;
        responseTimer = null;
      };

      const onAbort = (): void => {
        finish(failure("cancelled", "Dashboard request was cancelled."), true);
      };

      const finish = (result: DashboardRequestResult<T>, destroy = false): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        request.signal?.removeEventListener("abort", onAbort);
        this.cancellations.delete(req);
        if (destroy) {
          response?.destroy();
          req.destroy();
        }
        resolve(result);
      };

      const armResponseTimer = (): void => {
        if (settled || responseTimer) return;
        if (connectionTimer) clearTimeout(connectionTimer);
        connectionTimer = null;
        responseTimer = setTimeout(() => {
          finish(failure("timeout", "Dashboard response timed out."), true);
        }, responseTimeoutMs);
      };

      const options: http.RequestOptions = {
        method: request.method,
        headers: {
          Accept: "application/json",
          ...(serializedBody === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(serializedBody),
              }),
          ...(request.token === undefined ? {} : { Authorization: "Bearer " + request.token }),
        },
      };

      try {
        req = this.requestFactory(request.url, options, (res) => {
          if (settled) {
            res.destroy();
            return;
          }
          response = res;
          armResponseTimer();
          const status = res.statusCode ?? 0;
          const successful = status >= 200 && status < 300;
          const isJson = jsonContentType(res.headers["content-type"]);
          if (successful && !isJson) {
            res.resume();
            finish(
              failure("content-type", "Dashboard returned a non-JSON response.", status),
              true,
            );
            return;
          }

          const chunks: Buffer[] = [];
          let received = 0;
          res.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += bytes.length;
            if (received > maxResponseBytes) {
              finish(
                failure(
                  "response-too-large",
                  "Dashboard response exceeded the allowed size.",
                  status,
                ),
                true,
              );
              return;
            }
            chunks.push(bytes);
          });
          res.once("error", () => {
            finish(failure("connection", "Dashboard connection closed unexpectedly."), true);
          });
          res.once("aborted", () => {
            finish(failure("connection", "Dashboard connection closed unexpectedly."), true);
          });
          res.once("end", () => {
            if (settled) return;
            const text = Buffer.concat(chunks, received).toString("utf8");
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              if (!successful) {
                finish(failure("http", "Dashboard returned HTTP " + status + ".", status));
              } else {
                finish(failure("malformed-json", "Dashboard returned malformed JSON.", status));
              }
              return;
            }

            if (!successful) {
              finish(failure("http", "Dashboard returned HTTP " + status + ".", status, parsed));
              return;
            }
            const validated = request.parse(parsed);
            if (validated === null) {
              finish(
                failure("invalid-response", "Dashboard returned an invalid response.", status),
              );
              return;
            }
            finish({ ok: true, status, body: validated });
          });
        });
      } catch {
        resolve(failure("connection", "Dashboard request could not be started."));
        return;
      }

      this.cancellations.set(req, onAbort);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      connectionTimer = setTimeout(() => {
        finish(failure("timeout", "Dashboard connection timed out."), true);
      }, this.connectionTimeoutMs);

      req.once("socket", (socket) => {
        if (!socket.connecting) {
          armResponseTimer();
          return;
        }
        const event = request.url.protocol === "https:" ? "secureConnect" : "connect";
        socket.once(event, armResponseTimer);
      });
      req.once("error", () => {
        finish(failure("connection", "Could not connect to the dashboard."));
      });

      if (serializedBody !== undefined) req.write(serializedBody);
      req.end();
    });
  }
}
