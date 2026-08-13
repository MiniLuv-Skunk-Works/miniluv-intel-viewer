"use strict";
// Narrow bridge. The renderer gets exactly these calls and no Node access -
// contextIsolation stays on, so a bad string in a scan can't reach the OS.
import { contextBridge, ipcRenderer } from "electron";
import {
  parseBumpClearedEvent,
  parseBumpEvent,
  parseBumpResult,
  parseClipboardResult,
  parseConnectionStatus,
  parseDiagnosticsSnapshot,
  parseOpacity,
  parsePairResult,
  parseScan,
  parseScanRemovedEvent,
  parseScenarioCalculationOutcome,
  parseViewerScenarioCalculationRequest,
  parseViewerState,
  parseUpdateInfo,
  parseUserNotice,
  parseUserPreferences,
  defaultUserPreferences,
  type IpcEventContract,
  type IpcInvokeContract,
  type ViewerApi,
} from "./contracts";

async function invokeUnknown<K extends keyof IpcInvokeContract>(
  channel: K,
  payload: IpcInvokeContract[K]["request"],
): Promise<unknown> {
  return payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload);
}

function onIpc<K extends keyof IpcEventContract>(
  channel: K,
  listener: (value: unknown) => void,
): void {
  ipcRenderer.on(channel, (_event, value: unknown) => listener(value));
}

const api: ViewerApi = {
  pair: async (serverUrl, code) =>
    parsePairResult(await invokeUnknown("pair", { serverUrl, code })) ?? {
      ok: false,
      error: "Invalid pairing response.",
    },
  unpair: async () => (await invokeUnknown("unpair", undefined)) === true,
  state: async () =>
    parseViewerState(await invokeUnknown("state", undefined)) ?? {
      paired: false,
      serverUrl: "",
      opacity: 1,
    },
  // An integer level (0/1/2), not a window alpha. The renderer fades only the
  // background via CSS so text stays fully opaque; Electron's setOpacity would
  // fade the text too, which is the opposite of useful in an overlay.
  setOpacity: async (level) => parseOpacity(await invokeUnknown("opacity", level)) ?? 1,
  bump: async (scanId) =>
    parseBumpResult(await invokeUnknown("bump", scanId)) ?? {
      ok: false,
      error: "Invalid bump response.",
    },
  clipwatch: async (on) =>
    parseClipboardResult(await invokeUnknown("clipwatch", on)) ?? {
      on: false,
      stats: { sent: 0, ignored: 0, lastKind: null, lastAt: 0 },
      error: "Invalid clipboard response.",
    },
  preferences: async () =>
    parseUserPreferences(await invokeUnknown("preferences", undefined)) ?? defaultUserPreferences(),
  savePreferences: async (preferences) =>
    parseUserPreferences(await invokeUnknown("savePreferences", preferences)) ??
    defaultUserPreferences(),
  calculateScenario: async (request) => {
    const validated = parseViewerScenarioCalculationRequest(request);
    if (!validated) {
      return { ok: false, reason: "request-failed", message: "Invalid calculation request." };
    }
    return (
      parseScenarioCalculationOutcome(await invokeUnknown("scenarioCalculation", validated)) ?? {
        ok: false,
        reason: "request-failed",
        message: "Invalid calculation response.",
      }
    );
  },
  diagnostics: async () =>
    parseDiagnosticsSnapshot(await invokeUnknown("diagnostics", undefined)) ?? {
      appVersion: "unknown",
      serverOrigin: "",
      connection: { state: "offline" },
      errors: [],
      update: { status: "unknown", currentVersion: "unknown" },
    },
  checkUpdate: async () =>
    parseUpdateInfo(await invokeUnknown("checkUpdate", undefined)) ?? {
      status: "error",
      currentVersion: "unknown",
      error: "Invalid update response.",
    },
  openUpdate: async () => (await invokeUnknown("openUpdate", undefined)) === true,
  quit: async () => {
    await invokeUnknown("close", undefined);
  },
  onScan: (listener) =>
    onIpc("scan", (value) => {
      const scan = parseScan(value);
      if (scan) listener(scan);
    }),
  onScanRemoved: (listener) =>
    onIpc("scanRemoved", (value) => {
      const removed = parseScanRemovedEvent(value);
      if (removed) listener(removed);
    }),
  onStatus: (listener) =>
    onIpc("status", (value) => {
      const status = parseConnectionStatus(value);
      if (status) listener(status);
    }),
  onClear: (listener) => onIpc("clear", listener),
  onRepair: (listener) => onIpc("repair", listener),
  onBump: (listener) =>
    onIpc("bump", (value) => {
      const bump = parseBumpEvent(value);
      if (bump) listener(bump);
    }),
  onBumpCleared: (listener) =>
    onIpc("bumpCleared", (value) => {
      const cleared = parseBumpClearedEvent(value);
      if (cleared) listener(cleared);
    }),
  onClipWatch: (listener) =>
    onIpc("clipwatch", (value) => {
      const result = parseClipboardResult(value);
      if (result) listener(result);
    }),
  onUnpaired: (listener) => onIpc("unpaired", listener),
  onNotice: (listener) =>
    onIpc("notice", (value) => {
      const notice = parseUserNotice(value);
      if (notice) listener(notice);
    }),
  onUpdate: (listener) =>
    onIpc("update", (value) => {
      const update = parseUpdateInfo(value);
      if (update) listener(update);
    }),
};

contextBridge.exposeInMainWorld("milf", api);
