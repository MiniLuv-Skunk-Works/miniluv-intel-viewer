import * as http from "node:http";
import { EventEmitter } from "node:events";
import { DashboardClient } from "../dashboard-client";

let pass = 0;
let fail = 0;

function ok(name: string, condition: unknown, detail?: unknown): void {
  if (condition) {
    pass += 1;
    console.log("  PASS  " + name);
  } else {
    fail += 1;
    console.log("  FAIL  " + name + (detail === undefined ? "" : "  -> " + String(detail)));
  }
}

function objectWithOk(value: unknown): { ok: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { ok?: unknown };
  return typeof candidate.ok === "boolean" ? { ok: candidate.ok } : null;
}

void (async () => {
  const hits = new Map<string, number>();
  let observedAuthorization = "";
  let observedBody = "";
  const server = http.createServer((request, response) => {
    const route = request.url ?? "/";
    hits.set(route, (hits.get(route) ?? 0) + 1);
    observedAuthorization = String(request.headers.authorization ?? "");
    request.setEncoding("utf8");
    request.on("data", (chunk) => { observedBody += chunk; });
    request.on("end", () => {
      if (route === "/ok") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end('{"ok":true}');
      } else if (route === "/vendor") {
        response.writeHead(200, { "Content-Type": "application/problem+json" });
        response.end('{"ok":true}');
      } else if (route === "/http-error") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end('{"error":"unknown_scan"}');
      } else if (route === "/malformed") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{");
      } else if (route === "/wrong-type") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<p>no</p>");
      } else if (route === "/oversized") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, padding: "x".repeat(256) }));
      } else if (route === "/invalid") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"unexpected":true}');
      } else if (route === "/stalled" || route === "/cancel") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.flushHeaders();
      } else if (route === "/abrupt") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write("{");
        response.destroy();
      }
    });
  });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const client = new DashboardClient();

    console.log("\n=== bounded JSON client ===");
    const success = await client.requestJson({
      url: new URL("/ok", base),
      method: "POST",
      token: "test-token",
      body: { hello: "world" },
      parse: objectWithOk,
    });
    ok("POST JSON is bounded, authenticated, and parsed", success.ok && success.body.ok);
    ok("authorization and JSON body are sent", observedAuthorization === "Bearer test-token" && observedBody === '{"hello":"world"}');

    const vendor = await client.requestJson({ url: new URL("/vendor", base), method: "GET", parse: objectWithOk });
    ok("structured JSON content types are accepted", vendor.ok);

    const httpFailure = await client.requestJson({ url: new URL("/http-error", base), method: "GET", parse: objectWithOk });
    ok("HTTP failures retain bounded JSON error bodies", !httpFailure.ok && httpFailure.kind === "http" &&
      httpFailure.status === 404 && (httpFailure.body as { error?: string }).error === "unknown_scan");

    const malformed = await client.requestJson({ url: new URL("/malformed", base), method: "GET", parse: objectWithOk });
    ok("malformed JSON is normalized", !malformed.ok && malformed.kind === "malformed-json");

    const wrongType = await client.requestJson({ url: new URL("/wrong-type", base), method: "GET", parse: objectWithOk });
    ok("non-JSON success content is rejected", !wrongType.ok && wrongType.kind === "content-type");

    const oversized = await client.requestJson({
      url: new URL("/oversized", base), method: "GET", parse: objectWithOk, maxResponseBytes: 32,
    });
    ok("oversized responses stop before parsing", !oversized.ok && oversized.kind === "response-too-large");

    const invalid = await client.requestJson({ url: new URL("/invalid", base), method: "GET", parse: objectWithOk });
    ok("endpoint schema failures are normalized", !invalid.ok && invalid.kind === "invalid-response");

    const timedOut = await client.requestJson({
      url: new URL("/stalled", base), method: "GET", parse: objectWithOk, responseTimeoutMs: 25,
    });
    ok("stalled responses time out", !timedOut.ok && timedOut.kind === "timeout");

    const abrupt = await client.requestJson({ url: new URL("/abrupt", base), method: "GET", parse: objectWithOk });
    ok("abrupt response closure is normalized", !abrupt.ok && abrupt.kind === "connection");

    const pending = client.requestJson({
      url: new URL("/cancel", base), method: "GET", parse: objectWithOk, responseTimeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.cancelAll();
    const cancelled = await pending;
    ok("cancelAll resolves active requests as cancelled", !cancelled.ok && cancelled.kind === "cancelled");

    let starts = 0;
    class NeverConnects extends EventEmitter {
      write(): boolean { return true; }
      end(): void {}
      destroy(): this { return this; }
    }
    const connectionClient = new DashboardClient({
      connectionTimeoutMs: 10,
      request: () => {
        starts += 1;
        return new NeverConnects() as unknown as http.ClientRequest;
      },
    });
    const connectionTimeout = await connectionClient.requestJson({
      url: new URL("https://example.invalid"), method: "GET", parse: objectWithOk,
    });
    ok("connections have a separate timeout", !connectionTimeout.ok && connectionTimeout.kind === "timeout");
    ok("JSON operations are never retried", starts === 1 && [...hits.values()].every((count) => count === 1), [...hits.entries()]);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log("\n" + (fail === 0 ? "ALL " + pass + " PASSED" : pass + " passed, " + fail + " FAILED"));
    process.exit(fail === 0 ? 0 : 1);
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
