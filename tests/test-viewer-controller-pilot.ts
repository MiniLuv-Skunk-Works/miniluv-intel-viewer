import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AlertService } from "../src/alerting";
import type { ClipboardWatcher } from "../src/clipboard-watcher";
import {
  PROTOCOL_CAPABILITIES,
  type IpcEventContract,
  type Settings,
  type Vocabulary,
} from "../src/contracts";
import type { CredentialStore } from "../src/credentials";
import type { DashboardClient, DashboardJsonRequest } from "../src/dashboard-client";
import type { DiagnosticsRecorder } from "../src/diagnostics";
import type { FeedConnectionCallbacks } from "../src/feed-connection";
import type { AtomicJsonFile, SettingsStore } from "../src/settings-store";
import type { UpdateChecker } from "../src/update-checker";
import { ViewerController, type FeedConnectionLike } from "../src/viewer-controller";

describe("viewer pilot clipboard negotiation", () => {
  it("preserves opt-in but enables runtime validation only while compatible and connected", async () => {
    let callbacks: FeedConnectionCallbacks | undefined;
    let state: Settings = {
      serverUrl: "https://dashboard.example",
      watchClipboard: true,
      watchPilotClipboard: true,
    };
    const pilotRuntime: boolean[] = [];
    const pilotEvents: Array<IpcEventContract["pilotclipwatch"]> = [];
    const clipboard = {
      start: () => undefined,
      stop: () => undefined,
      stats: () => ({ sent: 0, ignored: 0, lastKind: null, lastAt: 0 }),
      vocabularySize: () => 1,
      setVocabulary: () => undefined,
      setPilotDetection: (enabled: boolean) => pilotRuntime.push(enabled),
    } as unknown as ClipboardWatcher;
    const settings = {
      get: () => state,
      scheduleSave: (patch: Partial<Settings>) => {
        state = { ...state, ...patch };
        return state;
      },
      flush: async () => undefined,
    } as unknown as SettingsStore;
    const dashboardClient = {
      requestJson: (_request: DashboardJsonRequest<unknown>) =>
        Promise.resolve({ ok: true, status: 200, body: { words: ["tritanium"] } }),
      cancelAll: () => undefined,
    } as unknown as DashboardClient;
    const feed: FeedConnectionLike = {
      start: () => undefined,
      stop: () => undefined,
      setReplayEnabled: () => undefined,
    };
    const controller = new ViewerController({
      settingsStore: settings,
      credentials: { get: () => "viewer-token" } as CredentialStore,
      vocabularyFile: {
        write: async () => true,
        flush: async () => undefined,
      } as unknown as AtomicJsonFile<Vocabulary>,
      dashboardClient,
      allowInsecureLocalhost: false,
      relay: <K extends keyof IpcEventContract>(channel: K, payload: IpcEventContract[K]) => {
        if (channel === "pilotclipwatch") {
          pilotEvents.push(payload as IpcEventContract["pilotclipwatch"]);
        }
      },
      createFeedConnection: (createdCallbacks) => {
        callbacks = createdCallbacks;
        return feed;
      },
      createClipboardWatcher: () => clipboard,
      alertService: {
        setArmed: () => undefined,
        configure: () => undefined,
      } as unknown as AlertService,
      diagnostics: {
        setConnection: () => undefined,
        record: () => undefined,
      } as unknown as DiagnosticsRecorder,
      updateChecker: {
        check: async () => undefined,
        cancel: () => undefined,
      } as unknown as UpdateChecker,
      appVersion: "test",
    });

    assert.ok(callbacks);
    callbacks.onEvent({
      event: "hello",
      data: JSON.stringify({
        name: "Dashboard without pilot relay",
        protocolVersion: 2,
        capabilities: Object.values(PROTOCOL_CAPABILITIES).filter(
          (capability) => capability !== PROTOCOL_CAPABILITIES.clipboardPilotRelay,
        ),
      }),
    });
    assert.deepEqual(controller.pilotClipboard(undefined), { on: true, available: false });

    callbacks.onEvent({
      event: "hello",
      data: JSON.stringify({
        name: "Compatible dashboard",
        protocolVersion: 2,
        capabilities: Object.values(PROTOCOL_CAPABILITIES),
      }),
    });
    assert.deepEqual(controller.pilotClipboard(undefined), { on: true, available: true });
    assert.equal(pilotRuntime.at(-1), true);

    callbacks.onStatus({ state: "reconnecting", detail: "2s" });
    assert.deepEqual(controller.pilotClipboard(undefined), { on: true, available: false });
    assert.equal(state.watchPilotClipboard, true);
    assert.equal(pilotRuntime.at(-1), false);

    const unavailableEnable = controller.pilotClipboard(true);
    assert.equal(unavailableEnable.error?.includes("compatible dashboard"), true);
    assert.equal(state.watchPilotClipboard, true);
    assert.ok(pilotEvents.length > 0);
    await controller.shutdown();
  });
});
