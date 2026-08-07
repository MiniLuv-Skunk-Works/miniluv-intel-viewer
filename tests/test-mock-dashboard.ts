import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseClaimResponse } from "../contracts";
import { DashboardClient } from "../dashboard-client";
import { FeedConnectionManager } from "../feed-connection";
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

    const events: string[] = [];
    const feed = new FeedConnectionManager({
      minimumRetryMs: 10,
      maximumRetryMs: 20,
      random: () => 0,
      onStatus: () => undefined,
      onEvent: (message) => {
        events.push(message.event);
        return message.event === "scan";
      },
      onUnauthorized: () => assert.fail("unexpected authentication failure"),
    });
    feed.start({ serverUrl: dashboard.url, token: dashboard.token });
    try {
      feed.setReplayEnabled(true);
      await dashboard.waitForFeedCount(1);
      dashboard.sendScan({ id: "scan-1", at: Date.now(), hull: "Obelisk" });
      await waitFor(() => events.includes("scan"));

      dashboard.disconnectFeeds();
      await dashboard.waitForFeedCount(1);
      const reconnect = dashboard.requests
        .filter((request) => request.path.endsWith("/feed"))
        .at(-1);
      assert.equal(reconnect?.lastEventId, "scan-1");
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
