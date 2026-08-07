import * as http from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { PROTOCOL_CAPABILITIES, type Scan } from "../../contracts";

export interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
  lastEventId?: string;
  body: unknown;
}

export class MockDashboard {
  private readonly server = http.createServer((request, response) => {
    void this.route(request, response);
  });
  private readonly feeds = new Set<http.ServerResponse>();
  private readonly sockets = new Set<Socket>();
  readonly requests: RecordedRequest[] = [];
  readonly token = "phase-five-test-token";
  readonly vocabulary = ["tritanium", "pyerite", "damage control ii", "obelisk"];
  url = "";

  constructor() {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("mock dashboard did not bind");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    this.disconnectFeeds();
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  feedCount(): number {
    return this.feeds.size;
  }

  send(event: string, data: unknown, id?: string): void {
    const frame = [
      `event: ${event}`,
      ...(id === undefined ? [] : [`id: ${id}`]),
      ...JSON.stringify(data)
        .split("\n")
        .map((line) => `data: ${line}`),
      "",
      "",
    ].join("\n");
    for (const feed of this.feeds) feed.write(frame);
  }

  sendHello(): void {
    this.send("hello", {
      name: "Phase 5 mock dashboard",
      protocolVersion: 1,
      capabilities: Object.values(PROTOCOL_CAPABILITIES),
      replay: { status: "snapshot" },
    });
  }

  sendScan(scan: Scan): void {
    this.send("scan", scan, scan.id);
  }

  disconnectFeeds(): void {
    for (const feed of this.feeds) feed.end();
    this.feeds.clear();
  }

  async waitForFeedCount(count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.feedCount() !== count) {
      if (Date.now() >= deadline) {
        throw new Error(`expected ${count} feeds, observed ${this.feedCount()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", this.url || "http://127.0.0.1").pathname;
    const bodyText = await this.readBody(request);
    let body: unknown = undefined;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    this.requests.push({
      method: request.method ?? "GET",
      path,
      ...(request.headers.authorization === undefined
        ? {}
        : { authorization: request.headers.authorization }),
      ...(request.headers["last-event-id"] === undefined
        ? {}
        : { lastEventId: String(request.headers["last-event-id"]) }),
      body,
    });

    if (path === "/api/viewer/claim" && request.method === "POST") {
      this.json(response, 200, { token: this.token });
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      this.json(response, 401, { error: "expired" });
      return;
    }
    if (path === "/api/viewer/vocabulary" && request.method === "GET") {
      this.json(response, 200, { words: this.vocabulary, buildNumber: 5 });
      return;
    }
    if (path === "/api/viewer/clip" && request.method === "POST") {
      this.json(response, 200, { delivered: 1 });
      return;
    }
    if (path === "/api/viewer/bump" && request.method === "POST") {
      const scanId =
        body && typeof body === "object" && "scanId" in body ? String(body.scanId) : "unknown";
      this.json(response, 200, { scanId, by: "tester", count: 1, holdMs: 180_000 });
      return;
    }
    if (path === "/api/feed" && request.method === "GET") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      this.feeds.add(response);
      response.on("close", () => this.feeds.delete(response));
      return;
    }
    this.json(response, 404, { error: "Not Found" });
  }

  private readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });
  }

  private json(response: http.ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
  }
}
