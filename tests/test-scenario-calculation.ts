import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AlertService } from "../src/alerting";
import {
  PROTOCOL_CAPABILITIES,
  type CombatScenario,
  type IpcEventContract,
  type ViewerScenarioCalculationRequest,
  type Vocabulary,
} from "../src/contracts";
import type { CredentialStore } from "../src/credentials";
import type { DashboardClient, DashboardJsonRequest } from "../src/dashboard-client";
import type { DiagnosticsRecorder } from "../src/diagnostics";
import type { FeedConnectionCallbacks } from "../src/feed-connection";
import type { AtomicJsonFile, SettingsStore } from "../src/settings-store";
import type { UpdateChecker } from "../src/update-checker";
import { ViewerController, type FeedConnectionLike } from "../src/viewer-controller";
import type { ClipboardWatcher } from "../src/clipboard-watcher";

describe("viewer scenario calculations", () => {
  it("sends one authenticated bounded request and rejects mismatched or rate-limited responses", async () => {
    let callbacks: FeedConnectionCallbacks | undefined;
    const requests: Array<DashboardJsonRequest<unknown>> = [];
    let nextResult: unknown;
    const dashboardClient = {
      requestJson: (request: DashboardJsonRequest<unknown>) => {
        requests.push(request);
        return Promise.resolve(nextResult);
      },
      cancelAll: () => undefined,
    } as unknown as DashboardClient;
    const feed: FeedConnectionLike = {
      start: () => undefined,
      stop: () => undefined,
      setReplayEnabled: () => undefined,
    };
    const clipboard = {
      start: () => undefined,
      stop: () => undefined,
      stats: () => ({ sent: 0, ignored: 0, lastKind: null, lastAt: 0 }),
      vocabularySize: () => 0,
      setPilotDetection: () => undefined,
    } as unknown as ClipboardWatcher;
    const alerts = {
      setArmed: () => undefined,
      configure: () => undefined,
    } as unknown as AlertService;
    const settings = {
      get: () => ({ serverUrl: "https://dashboard.example", watchClipboard: false }),
      flush: async () => true,
    } as unknown as SettingsStore;
    const controller = new ViewerController({
      settingsStore: settings,
      credentials: { get: () => "viewer-token" } as CredentialStore,
      vocabularyFile: { flush: async () => true } as unknown as AtomicJsonFile<Vocabulary>,
      dashboardClient,
      allowInsecureLocalhost: false,
      relay: <K extends keyof IpcEventContract>(_channel: K, _payload: IpcEventContract[K]) =>
        undefined,
      createFeedConnection: (createdCallbacks) => {
        callbacks = createdCallbacks;
        return feed;
      },
      createClipboardWatcher: () => clipboard,
      alertService: alerts,
      diagnostics: { setConnection: () => undefined } as unknown as DiagnosticsRecorder,
      updateChecker: { cancel: () => undefined } as unknown as UpdateChecker,
      appVersion: "test",
    });

    assert.ok(callbacks);
    callbacks.onEvent({
      event: "hello",
      data: JSON.stringify({
        name: "Scenario dashboard",
        protocolVersion: 2,
        capabilities: [PROTOCOL_CAPABILITIES.scanFeed, PROTOCOL_CAPABILITIES.scenarioCalculation],
      }),
    });
    const scenario: CombatScenario = {
      state: "prepped",
      securityStatus: "0.5",
      tankState: "active",
      implant: "none",
    };
    const request: ViewerScenarioCalculationRequest = {
      scanIds: ["scan-a", "scan-b"],
      scenario,
    };
    const response = {
      scenario,
      results: request.scanIds.map((scanId) => ({
        scanId,
        status: "ready" as const,
        tank: {
          selectedProfile: "Void (kin/therm)",
          selectedEhp: 600_000,
          ehpByProfile: { "Void (kin/therm)": 600_000 },
          overridden: false,
        },
        requirements: [{ name: "Talos" as const, ships: 12 }],
      })),
    };
    nextResult = { ok: true, status: 200, body: response };
    const success = await controller.calculateScenario(request);
    assert.equal(success.ok, true);
    assert.equal(requests.at(-1)?.url.pathname, "/api/viewer/scenario-calculations");
    assert.equal(requests.at(-1)?.token, "viewer-token");
    assert.deepEqual(requests.at(-1)?.body, request);
    assert.equal(requests.at(-1)?.maxResponseBytes, 256 * 1024);

    nextResult = {
      ok: true,
      status: 200,
      body: { ...response, scenario: { ...scenario, tankState: "passive" } },
    };
    assert.deepEqual(await controller.calculateScenario(request), {
      ok: false,
      reason: "request-failed",
      message: "Dashboard calculations did not match the request.",
    });

    nextResult = {
      ok: false,
      kind: "http",
      status: 429,
      message: "Dashboard returned HTTP 429.",
      body: { error: "rate_limited", detail: "Too many requests." },
    };
    assert.deepEqual(await controller.calculateScenario(request), {
      ok: false,
      reason: "rate-limited",
      message: "Too many requests.",
    });
    await controller.shutdown();
  });
});
