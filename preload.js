"use strict";
// Narrow bridge. The renderer gets exactly these calls and no Node access -
// contextIsolation stays on, so a bad string in a scan can't reach the OS.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("milf", {
  pair: (serverUrl, code) => ipcRenderer.invoke("pair", { serverUrl, code }),
  unpair: () => ipcRenderer.invoke("unpair"),
  state: () => ipcRenderer.invoke("state"),
  // An integer level (0/1/2), not a window alpha. The renderer fades only the
  // background via CSS so text stays fully opaque; Electron's setOpacity would
  // fade the text too, which is the opposite of useful in an overlay.
  setOpacity: (level) => ipcRenderer.invoke("opacity", level),
  bump: (scanId) => ipcRenderer.invoke("bump", scanId),
  quit: () => ipcRenderer.invoke("close"),
  onScan: (fn) => ipcRenderer.on("scan", (_e, d) => fn(d)),
  onStatus: (fn) => ipcRenderer.on("status", (_e, d) => fn(d)),
  onClear: (fn) => ipcRenderer.on("clear", () => fn()),
  onRepair: (fn) => ipcRenderer.on("repair", () => fn()),
  onBump: (fn) => ipcRenderer.on("bump", (_e, d) => fn(d)),
  onBumpCleared: (fn) => ipcRenderer.on("bumpCleared", (_e, d) => fn(d)),
  onUnpaired: (fn) => ipcRenderer.on("unpaired", () => fn())
});
