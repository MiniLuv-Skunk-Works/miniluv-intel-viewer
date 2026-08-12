"use strict";

// MILF Viewer is an ordinary always-on-top window. It deliberately does not
// inject into EVE or hook its rendering pipeline.
import { app, clipboard, ipcMain, Notification, safeStorage, shell } from "electron";
import { AlertService } from "./alerting";
import * as path from "node:path";
import { ClipboardWatcher } from "./clipboard-watcher";
import {
  parseSettingsDocument,
  parseVocabulary,
  type IpcEventContract,
  type Vocabulary,
} from "./contracts";
import { CredentialStore } from "./credentials";
import { DiagnosticsRecorder } from "./diagnostics";
import { registerIpcHandlers } from "./ipc-handlers";
import { AtomicJsonFile, SettingsStore } from "./settings-store";
import { ViewerController } from "./viewer-controller";
import { WindowManager } from "./window-manager";
import { allowedReleaseUrl, UpdateChecker } from "./update-checker";

const isolatedUserData = process.env.MILF_VIEWER_E2E_USER_DATA;
if (process.env.MILF_VIEWER_E2E === "1" && isolatedUserData && path.isAbsolute(isolatedUserData)) {
  app.setPath("userData", isolatedUserData);
}

const userData = app.getPath("userData");
const diagnostics = new DiagnosticsRecorder();
const settingsStore = new SettingsStore(
  path.join(userData, "settings.json"),
  parseSettingsDocument,
  {
    onError: (message, error) => {
      diagnostics.record(message.includes("read") ? "settings-read" : "settings-write");
      console.error(message, errorMessage(error));
    },
  },
);
const vocabularyFile = new AtomicJsonFile<Vocabulary>(
  path.join(userData, "vocabulary.json"),
  parseVocabulary,
  { onError: (message, error) => console.error(message, errorMessage(error)) },
);
const credentials = new CredentialStore(path.join(userData, "credential.bin"), safeStorage);

let windowManager: WindowManager;
const alertService = new AlertService(
  {
    enabled: false,
    muted: false,
    includeSensitiveDetails: false,
    minimumSplitValue: null,
    hulls: [],
    systems: [],
    routes: [],
    quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 7 * 60 },
  },
  {
    supported: () => Notification.isSupported(),
    notify: ({ title, body }) => {
      if (!Notification.isSupported()) {
        diagnostics.record("notification");
        return;
      }
      const notification = new Notification({ title, body });
      notification.on("click", () => windowManager?.show());
      notification.show();
    },
  },
);
const updateChecker = new UpdateChecker({
  currentVersion: app.getVersion(),
  getCache: () => settingsStore.get().updateCache,
  saveCache: async (updateCache) => {
    await settingsStore.saveNow({ updateCache });
  },
  onUpdate: (update) => windowManager?.relay("update", update),
  onError: () => diagnostics.record("update-check"),
});
const controller = new ViewerController({
  settingsStore,
  credentials,
  vocabularyFile,
  allowInsecureLocalhost: app.commandLine.hasSwitch("allow-insecure-localhost"),
  relay: <K extends keyof IpcEventContract>(channel: K, payload: IpcEventContract[K]) =>
    windowManager?.relay(channel, payload),
  createClipboardWatcher: (callbacks) =>
    new ClipboardWatcher({
      ...callbacks,
      readText: () => clipboard.readText(),
    }),
  alertService,
  diagnostics,
  updateChecker,
  appVersion: app.getVersion(),
});

windowManager = new WindowManager({
  settingsStore,
  rendererDirectory: path.join(__dirname, "..", "src", "renderer"),
  compiledDirectory: __dirname,
  actions: {
    quit: () => app.quit(),
    clipboardWatching: () => controller.clipboardWatching(),
    setClipboardWatching: (on) => controller.setClipboardWatching(on),
  },
  onError: (message, error) => console.warn(message, errorMessage(error)),
});

const disposeIpc = registerIpcHandlers({
  ipcMain,
  actions: {
    pair: (request) => controller.pair(request),
    unpair: () => controller.unpair(),
    state: () => controller.state(),
    setOpacity: (level) => controller.setOpacity(level),
    bump: (scanId) => controller.bump(scanId),
    clipboard: (on) => controller.clipboard(on),
    preferences: () => controller.preferences(),
    savePreferences: (preferences) => controller.savePreferences(preferences),
    calculateScenario: (request) => controller.calculateScenario(request),
    diagnostics: () => controller.diagnostics(),
    checkUpdate: () => controller.checkUpdate(),
    openUpdate: async () => {
      const url = updateChecker.cachedInfo().releaseUrl;
      if (!url || !allowedReleaseUrl(url)) return false;
      try {
        await shell.openExternal(url);
        return true;
      } catch {
        diagnostics.record("external-link");
        return false;
      }
    },
  },
  getWebContents: () => windowManager.getWebContents(),
  quit: () => app.quit(),
});

let shutdownStarted = false;
let shutdownReady = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => windowManager.show());
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    windowManager.beginShutdown();
    if (shutdownReady) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    disposeIpc();
    void controller.shutdown().finally(() => {
      shutdownReady = true;
      app.exit(0);
    });
  });

  void app.whenReady().then(async () => {
    await controller.initialize();
    windowManager.create();
    controller.start();
  });
}
