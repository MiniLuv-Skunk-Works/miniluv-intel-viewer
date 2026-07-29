"use strict";
// Narrow bridge. The renderer gets exactly these calls and no Node access -
// contextIsolation stays on, so a bad string in a scan can't reach the OS.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("milf", {
  pair: (serverUrl, code) => ipcRenderer.invoke("pair", { serverUrl, code }),
  state: () => ipcRenderer.invoke("state"),
  hotkey: () => ipcRenderer.invoke("hotkey"),
  setClickThrough: (on) => ipcRenderer.invoke("clickthrough", on),
  quit: () => ipcRenderer.invoke("close"),
  onScan: (fn) => ipcRenderer.on("scan", (_e, d) => fn(d)),
  onStatus: (fn) => ipcRenderer.on("status", (_e, d) => fn(d)),
  onUnpaired: (fn) => ipcRenderer.on("unpaired", () => fn()),
  onClear: (fn) => ipcRenderer.on("clear", () => fn()),
  onClickThrough: (fn) => ipcRenderer.on("clickthrough", (_e, d) => fn(d))
});
