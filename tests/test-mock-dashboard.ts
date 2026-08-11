import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseClaimResponse } from "../src/contracts";
import { DashboardClient } from "../src/dashboard-client";
import { FeedConnectionManager } from "../src/feed-connection";
import { MockDashboard } from "./support/mock-dashboard";

describe("local mock dashboard", () => {
  const dashboard = new MockDashboard();
  before(() => dashboard.start());
  after(() => dashboard.close());

  it("supports bounded claims and controllable SSE replay", { timeout: 10_000 }, async () => {
    const client = new DashboardClient();
    const claim = await client.requestJson({
      url: new URL("/api/viewer/claim", dashboard.url),
      method: "POST",
      body: { code: "ABCD-EFGH" },
      parse: parseClaimResponse,
    });
    assert.equal(claim.ok && claim.body.token, dashboard.token);

    const events: Array<{ revisionId: string; scanId: string; hull?: string }> = [];
    const feed = new FeedConnectionManager({
      minimumRetryMs: 10,
      maximumRetryMs: 20,
      random: () => 0,
      onStatus: () => undefined,
      onEvent: (message) => {
        if (message.event !== "scan" || !message.id) return false;
        const scan = JSON.parse(message.data) as { id: string; hull?: string };
        events.push({
          revisionId: message.id,
          scanId: scan.id,
          ...(scan.hull === undefined ? {} : { hull: scan.hull }),
        });
        return true;
      },
      onUnauthorized: () => assert.fail("unexpected authentication failure"),
    });
    feed.start({ serverUrl: dashboard.url, token: dashboard.token });
    try {
      feed.setReplayEnabled(true);
      await dashboard.waitForFeedCount(1);
      dashboard.sendScan({ id: "scan-1", at: Date.now(), hull: "Obelisk" }, "revision-1");
      dashboard.sendScan({ id: "scan-1", at: Date.now(), hull: "Bowhead" }, "revision-2");
      dashboard.sendScan({ id: "scan-1", at: Date.now(), hull: "Bowhead" }, "revision-2");
      await waitFor(() => events.length === 2);

      dashboard.disconnectFeeds();
      await dashboard.waitForFeedCount(1);
      const reconnect = dashboard.requests
        .filter((request) => request.path.endsWith("/feed"))
        .at(-1);
      assert.equal(reconnect?.lastEventId, "revision-2");

      dashboard.sendScan({ id: "scan-1", at: Date.now(), hull: "Bowhead" }, "revision-2");
      dashboard.sendScan({ id: "scan-1", at: Date.now(), hull: "Orca" }, "revision-3");
      await waitFor(() => events.length === 3);
      assert.deepEqual(events, [
        { revisionId: "revision-1", scanId: "scan-1", hull: "Obelisk" },
        { revisionId: "revision-2", scanId: "scan-1", hull: "Bowhead" },
        { revisionId: "revision-3", scanId: "scan-1", hull: "Orca" },
      ]);
    } finally {
      feed.stop();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
