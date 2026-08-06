"use strict";

// MILF Viewer is an ordinary always-on-top window. It deliberately does not
// inject into EVE or hook its rendering pipeline.
import { app, clipboard, ipcMain, safeStorage } from "electron";
import * as path from "node:path";
import { ClipboardWatcher } from "./clipboard-watcher";
import {
  parseSettingsDocument,
  parseVocabulary,
  type IpcEventContract,
  type Vocabulary,
} from "./contracts";
import { CredentialStore } from "./credentials";
import { registerIpcHandlers } from "./ipc-handlers";
import { AtomicJsonFile, SettingsStore } from "./settings-store";
import { ViewerController } from "./viewer-controller";
import { WindowManager } from "./window-manager";

const isolatedUserData = process.env.MILF_VIEWER_E2E_USER_DATA;
if (process.env.MILF_VIEWER_E2E === "1" && isolatedUserData && path.isAbsolute(isolatedUserData)) {
  app.setPath("userData", isolatedUserData);
}

const userData = app.getPath("userData");
const settingsStore = new SettingsStore(
  path.join(userData, "settings.json"),
  parseSettingsDocument,
  { onError: (message, error) => console.error(message, errorMessage(error)) },
);
const vocabularyFile = new AtomicJsonFile<Vocabulary>(
  path.join(userData, "vocabulary.json"),
  parseVocabulary,
  { onError: (message, error) => console.error(message, errorMessage(error)) },
);
const credentials = new CredentialStore(path.join(userData, "credential.bin"), safeStorage);

let windowManager: WindowManager;
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
});

windowManager = new WindowManager({
  settingsStore,
  rendererDirectory: path.join(__dirname, "..", "renderer"),
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
  actions: controller,
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
