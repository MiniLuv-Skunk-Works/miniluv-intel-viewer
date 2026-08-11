import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AlertService } from "../src/alerting";
import {
  PROTOCOL_CAPABILITIES,
  type IpcEventContract,
  type Scan,
  type Vocabulary,
} from "../src/contracts";
import type { CredentialStore } from "../src/credentials";
import type { DiagnosticsRecorder } from "../src/diagnostics";
import type { FeedConnectionCallbacks } from "../src/feed-connection";
import type { AtomicJsonFile, SettingsStore } from "../src/settings-store";
import type { UpdateChecker } from "../src/update-checker";
import { ViewerController, type FeedConnectionLike } from "../src/viewer-controller";
import type { ClipboardWatcher } from "../src/clipboard-watcher";

describe("viewer scan revisions", () => {
  it("accepts independent revision IDs and alerts only for the first stable scan", async () => {
    let callbacks: FeedConnectionCallbacks | undefined;
    const relayedScans: Scan[] = [];
    const alertedScans: Scan[] = [];
    const replayModes: boolean[] = [];

    const feed: FeedConnectionLike = {
      start: () => undefined,
      stop: () => undefined,
      setReplayEnabled: (enabled) => replayModes.push(enabled),
    };
    const clipboard = {
      start: () => undefined,
      stop: () => undefined,
      stats: () => ({ sent: 0, ignored: 0, lastKind: null, lastAt: 0 }),
      vocabularySize: () => 0,
    } as unknown as ClipboardWatcher;
    const alerts = {
      setArmed: () => undefined,
      configure: () => undefined,
      handle: (scan: Scan) => {
        alertedScans.push(scan);
        return true;
      },
    } as unknown as AlertService;
    const settings = {
      get: () => ({ watchClipboard: false }),
      flush: async () => undefined,
    } as unknown as SettingsStore;
    const vocabularyFile = {
      flush: async () => undefined,
    } as unknown as AtomicJsonFile<Vocabulary>;
    const diagnostics = {
      setConnection: () => undefined,
    } as unknown as DiagnosticsRecorder;
    const updates = {
      cancel: () => undefined,
    } as unknown as UpdateChecker;

    const controller = new ViewerController({
      settingsStore: settings,
      credentials: {} as CredentialStore,
      vocabularyFile,
      allowInsecureLocalhost: false,
      relay: <K extends keyof IpcEventContract>(channel: K, payload: IpcEventContract[K]) => {
        if (channel === "scan") relayedScans.push(payload as Scan);
      },
      createFeedConnection: (createdCallbacks) => {
        callbacks = createdCallbacks;
        return feed;
      },
      createClipboardWatcher: () => clipboard,
      alertService: alerts,
      diagnostics,
      updateChecker: updates,
      appVersion: "test",
    });

    assert.ok(callbacks);
    callbacks.onEvent({
      event: "hello",
      data: JSON.stringify({
        name: "Update-aware dashboard",
        protocolVersion: 1,
        capabilities: Object.values(PROTOCOL_CAPABILITIES),
      }),
    });
    const original = { id: "stable-scan", at: 1, hull: "Obelisk" };
    const edited = { id: "stable-scan", at: 2, hull: "Bowhead" };
    assert.equal(
      callbacks.onEvent({ event: "scan", id: "revision-1", data: JSON.stringify(original) }),
      true,
    );
    assert.equal(
      callbacks.onEvent({ event: "scan", id: "revision-2", data: JSON.stringify(edited) }),
      true,
    );
    assert.equal(
      callbacks.onEvent({ event: "scan", id: "bad\nrevision", data: JSON.stringify(edited) }),
      false,
    );

    assert.deepEqual(replayModes, [true]);
    assert.deepEqual(
      relayedScans.map((scan) => scan.hull),
      ["Obelisk", "Bowhead"],
    );
    assert.deepEqual(
      alertedScans.map((scan) => scan.hull),
      ["Obelisk"],
    );
    await controller.shutdown();
  });
});
