import type * as http from "node:http";
import { EventEmitter } from "node:events";
import { FeedConnectionManager, SseFrameTooLargeError, SseParser } from "../feed-connection";
import { ok } from "./support/assertions";

interface ClockEntry {
  callback: () => void;
  delay: number;
  cleared: boolean;
}

class FakeClock {
  readonly entries: ClockEntry[] = [];

  readonly set = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const entry: ClockEntry = { callback, delay, cleared: false };
    this.entries.push(entry);
    return entry as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clear = (timer: ReturnType<typeof setTimeout>): void => {
    (timer as unknown as ClockEntry).cleared = true;
  };

  active(delay?: number): ClockEntry[] {
    return this.entries.filter(
      (entry) => !entry.cleared && (delay === undefined || entry.delay === delay),
    );
  }

  run(entry: ClockEntry): void {
    if (entry.cleared) return;
    entry.cleared = true;
    entry.callback();
  }
}

class FakeSocket extends EventEmitter {
  connecting = false;
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  readonly socket = new FakeSocket();

  write(): boolean {
    return true;
  }
  end(): void {
    this.emit("socket", this.socket);
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class FakeResponse extends EventEmitter {
  destroyed = false;
  resumed = false;

  constructor(
    readonly statusCode: number,
    readonly headers: http.IncomingHttpHeaders,
  ) {
    super();
  }

  setEncoding(): this {
    return this;
  }
  resume(): this {
    this.resumed = true;
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

interface Attempt {
  url: URL;
  options: http.RequestOptions;
  request: FakeRequest;
  respond(status?: number, contentType?: string): FakeResponse;
}

function harness() {
  const attempts: Attempt[] = [];
  const request = (
    url: URL,
    options: http.RequestOptions,
    callback: (response: http.IncomingMessage) => void,
  ): http.ClientRequest => {
    const fakeRequest = new FakeRequest();
    const attempt: Attempt = {
      url,
      options,
      request: fakeRequest,
      respond(status = 200, contentType = "text/event-stream; charset=utf-8") {
        const response = new FakeResponse(status, { "content-type": contentType });
        callback(response as unknown as http.IncomingMessage);
        return response;
      },
    };
    attempts.push(attempt);
    return fakeRequest as unknown as http.ClientRequest;
  };
  return { attempts, request };
}

console.log("\n=== incremental SSE parser ===");
const parser = new SseParser();
ok("heartbeat comments do not emit events", parser.push(": heartbeat\r\n\r\n").length === 0);
const first = parser.push("event: scan\r\ndata: first line\r\nda");
const second = parser.push("ta:  second line\r\nid: scan-1\r\n\r\n");
ok(
  "CRLF framing survives chunk splits",
  first.length === 0 && second.length === 1 && second[0]?.event === "scan",
);
ok(
  "multi-line data preserves newlines and field spaces",
  second[0]?.data === "first line\n second line",
  second[0]?.data,
);
ok(
  "SSE event IDs are parsed without leaking to later frames",
  second[0]?.id === "scan-1" && parser.push("data: next\n\n")[0]?.id === undefined,
);
const lf = parser.push('data:{"ok":true}\n\n');
ok(
  "LF framing and default message events work",
  lf[0]?.event === "message" && lf[0]?.data === '{"ok":true}',
);
let oversized = false;
try {
  new SseParser(8).push("data: too much");
} catch (error) {
  oversized = error instanceof SseFrameTooLargeError;
}
ok("unfinished frames are bounded", oversized);

console.log("\n=== feed connection ownership and retry ===");
const clock = new FakeClock();
const transport = harness();
const statuses: string[] = [];
const messages: string[] = [];
let unauthorized = 0;
const manager = new FeedConnectionManager({
  request: transport.request,
  setTimer: clock.set,
  clearTimer: clock.clear,
  random: () => 0,
  connectionTimeoutMs: 10,
  responseTimeoutMs: 20,
  idleTimeoutMs: 100,
  staleTimeoutMs: 50,
  onStatus: (status) =>
    statuses.push(status.state + ("detail" in status ? ":" + status.detail : "")),
  onEvent: (message) => {
    messages.push(message.event + ":" + message.data);
    return true;
  },
  onUnauthorized: () => {
    unauthorized += 1;
  },
});

manager.start({ serverUrl: "https://old.example", token: "old-token" });
ok("start owns exactly one request", transport.attempts.length === 1);
ok(
  "feed authorization stays in the main process",
  transport.attempts[0]?.options.headers !== undefined &&
    (transport.attempts[0]?.options.headers as Record<string, string>).Authorization ===
      "Bearer old-token",
);
const oldResponse = transport.attempts[0]?.respond();
oldResponse?.emit("data", 'event: scan\ndata: {"id":1}\n\n');
ok("parsed events are relayed", messages[0] === 'scan:{"id":1}');
oldResponse?.emit("end");
oldResponse?.emit("error", new Error("duplicate"));
oldResponse?.emit("aborted");
ok(
  "repeated end/error signals schedule one retry",
  clock.active(500).length === 1,
  clock.active().map((entry) => entry.delay),
);
const retry = clock.active(500)[0];
if (retry) clock.run(retry);
ok("equal jitter is applied to exponential backoff", transport.attempts.length === 2);

const secondResponse = transport.attempts[1]?.respond();
secondResponse?.emit("end");
ok("backoff doubles when a stream closes before activity", clock.active(1_000).length === 1);
const secondRetry = clock.active(1_000)[0];
if (secondRetry) clock.run(secondRetry);

const staleAttempt = transport.attempts[2];
manager.start({ serverUrl: "https://new.example", token: "new-token" });
ok(
  "rapid re-pair replaces the request immediately",
  staleAttempt?.request.destroyed && transport.attempts.length === 4,
);
const statusCount = statuses.length;
staleAttempt?.request.emit("error", new Error("late"));
const staleResponse = staleAttempt?.respond();
staleResponse?.emit("data", "data: stale\n\n");
staleResponse?.emit("end");
ok(
  "stale callbacks cannot emit status or events",
  statuses.length === statusCount && !messages.includes("message:stale"),
);
ok(
  "the replacement uses only the new dashboard and token",
  transport.attempts[3]?.url.origin === "https://new.example" &&
    (transport.attempts[3]?.options.headers as Record<string, string>).Authorization ===
      "Bearer new-token",
);

manager.stop();
const attemptsAfterStop = transport.attempts.length;
staleResponse?.emit("end");
ok(
  "stop cancels requests and prevents reconnection",
  clock.active().length === 0 && transport.attempts.length === attemptsAfterStop,
);

console.log("\n=== offline scan replay ===");
const replayClock = new FakeClock();
const replayTransport = harness();
const replayedScans: string[] = [];
const replayManager = new FeedConnectionManager({
  request: replayTransport.request,
  setTimer: replayClock.set,
  clearTimer: replayClock.clear,
  random: () => 0,
  onStatus: () => {},
  onEvent: (message) => {
    if (message.event !== "scan") return true;
    const payload = JSON.parse(message.data) as { id?: unknown; at?: unknown };
    if (
      typeof payload.id !== "string" ||
      typeof payload.at !== "number" ||
      message.id !== payload.id
    )
      return false;
    replayedScans.push(payload.id);
    return true;
  },
  onUnauthorized: () => {},
});
replayManager.start({ serverUrl: "https://replay.example", token: "token" });
const firstReplayResponse = replayTransport.attempts[0]?.respond();
replayManager.setReplayEnabled(true);
firstReplayResponse?.emit("data", 'event: scan\nid: scan-1\ndata: {"id":"scan-1","at":1}\n\n');
firstReplayResponse?.emit("end");
const firstReplayRetry = replayClock.active(500)[0];
if (firstReplayRetry) replayClock.run(firstReplayRetry);
ok(
  "reconnect sends the latest accepted scan cursor",
  (replayTransport.attempts[1]?.options.headers as Record<string, string> | undefined)?.[
    "Last-Event-ID"
  ] === "scan-1",
);
const secondReplayResponse = replayTransport.attempts[1]?.respond();
secondReplayResponse?.emit(
  "data",
  'event: scan\nid: scan-1\ndata: {"id":"scan-1","at":1}\n\n' +
    'event: scan\nid: scan-2\ndata: {"id":"scan-2","at":2}\n\n' +
    'event: scan\nid: Unicode Ω\ndata: {"id":"Unicode Ω","at":3}\n\n' +
    'event: scan\nid: Unicode Ω\ndata: {"id":"Unicode Ω","at":3}\n\n' +
    'event: scan\nid: malformed\ndata: {"id":"malformed"}\n\n',
);
ok(
  "replayed, live, and Unicode scan IDs are delivered exactly once",
  replayedScans.join(",") === "scan-1,scan-2,Unicode Ω",
  replayedScans,
);
secondReplayResponse?.emit("end");
const secondReplayRetry = replayClock.active(500)[0];
if (secondReplayRetry) replayClock.run(secondReplayRetry);
ok(
  "rejected or untransmittable IDs cannot advance the replay cursor",
  (replayTransport.attempts[2]?.options.headers as Record<string, string> | undefined)?.[
    "Last-Event-ID"
  ] === "scan-2",
);
replayManager.stop();

console.log("\n=== heartbeat, idle, timeout, and authentication handling ===");
const idleClock = new FakeClock();
const idleTransport = harness();
const idleStatuses: string[] = [];
const idleManager = new FeedConnectionManager({
  request: idleTransport.request,
  setTimer: idleClock.set,
  clearTimer: idleClock.clear,
  random: () => 1,
  connectionTimeoutMs: 10,
  responseTimeoutMs: 20,
  idleTimeoutMs: 100,
  staleTimeoutMs: 50,
  onStatus: (status) =>
    idleStatuses.push(status.state + ("detail" in status ? ":" + status.detail : "")),
  onEvent: () => {},
  onUnauthorized: () => {
    unauthorized += 1;
  },
});
idleManager.start({ serverUrl: "https://idle.example", token: "idle-token" });
const idleResponse = idleTransport.attempts[0]?.respond();
const originalIdle = idleClock.active(100)[0];
const originalStale = idleClock.active(50)[0];
idleResponse?.emit("data", ": heartbeat\n\n");
ok(
  "heartbeat activity resets the idle deadline",
  originalIdle?.cleared && originalStale?.cleared && idleClock.active(100).length === 1,
);
const currentStale = idleClock.active(50)[0];
if (currentStale) idleClock.run(currentStale);
ok("silent live feeds become stale before disconnecting", idleStatuses.includes("stale"));
idleResponse?.emit("data", ": heartbeat\n\n");
ok("stream activity restores a stale feed to live", idleStatuses.at(-1) === "live");
const currentIdle = idleClock.active(100)[0];
if (currentIdle) idleClock.run(currentIdle);
ok(
  "idle streams are closed and scheduled to reconnect",
  idleStatuses.some((status) => status.includes("idle timeout")) &&
    idleClock.active(1_000).length === 1 &&
    idleResponse?.destroyed,
);
idleManager.stop();

const timeoutClock = new FakeClock();
const timeoutTransport = harness();
const timeoutManager = new FeedConnectionManager({
  request: timeoutTransport.request,
  setTimer: timeoutClock.set,
  clearTimer: timeoutClock.clear,
  connectionTimeoutMs: 10,
  responseTimeoutMs: 20,
  onStatus: () => {},
  onEvent: () => {},
  onUnauthorized: () => {},
});
timeoutManager.start({ serverUrl: "https://timeout.example", token: "token" });
const responseDeadline = timeoutClock.active(20)[0];
if (responseDeadline) timeoutClock.run(responseDeadline);
ok(
  "the initial feed response has a deadline",
  timeoutClock.active().some((entry) => entry.delay >= 500),
);
timeoutManager.stop();

const contentClock = new FakeClock();
const contentTransport = harness();
const contentStatuses: string[] = [];
const contentManager = new FeedConnectionManager({
  request: contentTransport.request,
  setTimer: contentClock.set,
  clearTimer: contentClock.clear,
  onStatus: (status) =>
    contentStatuses.push(status.state + ("detail" in status ? ":" + status.detail : "")),
  onEvent: () => {},
  onUnauthorized: () => {},
});
contentManager.start({ serverUrl: "https://content.example", token: "token" });
const wrongContent = contentTransport.attempts[0]?.respond(200, "application/json");
ok(
  "non-SSE feed content is rejected and retried",
  wrongContent?.destroyed &&
    contentStatuses.some((status) => status.includes("non-SSE")) &&
    contentClock.active().length === 1,
);
contentManager.stop();

const authClock = new FakeClock();
const authTransport = harness();
const authManager = new FeedConnectionManager({
  request: authTransport.request,
  setTimer: authClock.set,
  clearTimer: authClock.clear,
  onStatus: () => {},
  onEvent: () => {},
  onUnauthorized: () => {
    unauthorized += 1;
  },
});
authManager.start({ serverUrl: "https://auth.example", token: "expired" });
authTransport.attempts[0]?.respond(401, "application/json");
ok(
  "authentication expiry is terminal and does not retry",
  unauthorized === 1 && authClock.active().length === 0,
);
