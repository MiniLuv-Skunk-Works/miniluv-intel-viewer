import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AlertService,
  isQuietTime,
  notificationForScan,
  scanMatchesAlert,
  scanMatchesFilter,
} from "../src/alerting";
import {
  defaultUserPreferences,
  parseConnectionStatus,
  parseUserPreferences,
  type Scan,
  type UpdateCache,
  type UpdateInfo,
} from "../src/contracts";
import { DiagnosticsRecorder } from "../src/diagnostics";
import { allowedReleaseUrl, compareVersions, UpdateChecker } from "../src/update-checker";

const scan: Scan = {
  id: "scan-1",
  at: 1,
  hull: "Obelisk",
  pilot: "Pilot One",
  scout: "Scout One",
  system: "Jita",
  scanGate: "Sivala",
  headGate: "Uedama",
  valueSplit: 750_000_000,
};

describe("Phase 8 alerting and filtering", () => {
  it("uses OR alert criteria with exact normalized names and split value", () => {
    const preferences = defaultUserPreferences().alerts;
    preferences.minimumSplitValue = 1_000_000_000;
    preferences.hulls = [" obelisk "];
    assert.equal(scanMatchesAlert(scan, preferences), true);
    preferences.hulls = ["Obelisk Navy Issue"];
    assert.equal(scanMatchesAlert(scan, preferences), false);
    preferences.routes = ["uedama"];
    assert.equal(scanMatchesAlert(scan, preferences), true);
  });

  it("combines compact text and minimum split filters", () => {
    assert.equal(
      scanMatchesFilter(scan, { query: "pilot one", minimumSplitValue: 700_000_000 }),
      true,
    );
    assert.equal(
      scanMatchesFilter(scan, { query: "amarr", minimumSplitValue: 700_000_000 }),
      false,
    );
    assert.equal(scanMatchesFilter(scan, { query: "jita", minimumSplitValue: 800_000_000 }), false);
  });

  it("supports overnight quiet hours and privacy-safe notification defaults", () => {
    const preferences = defaultUserPreferences().alerts;
    preferences.quietHours = { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 };
    assert.equal(isQuietTime(preferences, new Date(2026, 0, 1, 23, 0)), true);
    assert.equal(isQuietTime(preferences, new Date(2026, 0, 1, 12, 0)), false);
    assert.doesNotMatch(notificationForScan(scan, false).body, /Obelisk|Jita|Sivala/);
    assert.match(notificationForScan(scan, true).title, /Obelisk.*Jita/);
  });

  it("requires opt-in, arming, and an unmuted matching rule", () => {
    const notifications: string[] = [];
    const preferences = defaultUserPreferences().alerts;
    preferences.enabled = true;
    preferences.hulls = ["Obelisk"];
    const service = new AlertService(preferences, {
      supported: () => true,
      notify: (notification) => notifications.push(notification.title),
      now: () => new Date(2026, 0, 1, 12, 0),
    });
    service.handle(scan);
    service.setArmed(true);
    service.handle(scan);
    preferences.muted = true;
    service.configure(preferences);
    service.handle(scan);
    assert.equal(notifications.length, 1);
  });
});

describe("Phase 8 boundaries and diagnostics", () => {
  it("strictly validates saved preferences and new connection states", () => {
    const preferences = defaultUserPreferences();
    assert.deepEqual(parseUserPreferences(preferences), preferences);
    preferences.alerts.quietHours = { enabled: true, startMinute: 60, endMinute: 60 };
    assert.equal(parseUserPreferences(preferences), null);
    assert.equal(
      parseConnectionStatus({ state: "replaying", lastEventAt: 10 })?.state,
      "replaying",
    );
    assert.equal(parseConnectionStatus({ state: "stale", secret: "x" }), null);
  });

  it("retains only ten fixed redacted diagnostic errors", () => {
    let now = 0;
    const recorder = new DiagnosticsRecorder(() => ++now);
    for (let index = 0; index < 12; index += 1) recorder.record("feed-timeout");
    const snapshot = recorder.snapshot("0.4.0", "https://dashboard.example", {
      status: "up-to-date",
      currentVersion: "0.4.0",
    });
    assert.equal(snapshot.errors.length, 10);
    assert.equal(snapshot.errors[0]?.at, 3);
    assert.doesNotMatch(JSON.stringify(snapshot.errors), /token|scan-1/i);
  });
});

describe("Phase 8 stable release awareness", () => {
  it("compares stable versions and allowlists only this repository's release pages", () => {
    assert.equal(compareVersions("0.4.0", "0.5.0"), -1);
    assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
    assert.equal(compareVersions("continuous", "1.2.3"), null);
    assert.equal(
      allowedReleaseUrl(
        "https://github.com/MiniLuv-Skunk-Works/miniluv-intel-viewer/releases/tag/v0.5.0",
      ),
      true,
    );
    assert.equal(allowedReleaseUrl("https://github.com/other/repo/releases/tag/v9.0.0"), false);
    assert.equal(
      allowedReleaseUrl(
        "https://github.com/MiniLuv-Skunk-Works/miniluv-intel-viewer/releases/tag/v0.5.0?token=x",
      ),
      false,
    );
  });

  it("uses a recent cached stable release without making a request", async () => {
    const now = 1_800_000_000_000;
    const cache: UpdateCache = {
      checkedAt: now - 1_000,
      release: {
        version: "0.5.0",
        title: "MILF Viewer 0.5.0",
        notes: "Safe notes",
        publishedAt: "2026-08-06T00:00:00Z",
        releaseUrl:
          "https://github.com/MiniLuv-Skunk-Works/miniluv-intel-viewer/releases/tag/v0.5.0",
      },
    };
    const updates: UpdateInfo[] = [];
    const checker = new UpdateChecker({
      currentVersion: "0.4.0",
      getCache: () => cache,
      saveCache: () => undefined,
      onUpdate: (update) => updates.push(update),
      onError: () => assert.fail("cached checks must not fail"),
      now: () => now,
      request: () => assert.fail("cached checks must not use the network"),
    });
    const result = await checker.check(false);
    assert.equal(result.status, "available");
    assert.equal(updates.at(-1)?.latestVersion, "0.5.0");
  });
});
