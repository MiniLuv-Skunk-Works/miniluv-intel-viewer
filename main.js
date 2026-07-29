"use strict";
// M.I.L.F Viewer - MiniLuv Intel Live Feed
//
// A borderless always-on-top window that sits over EVE and shows scans as
// they're posted. Deliberately NOT an injected overlay: hooking DirectX to
// draw inside the game client is the pattern CCP's EULA prohibits, and no
// convenience is worth a SIG-wide ban. This is an ordinary window that floats.
//
// Works with windowed and borderless-fullscreen EVE. Exclusive fullscreen will
// cover it - that's a limitation of not injecting, and the right trade.

const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const STORE = path.join(app.getPath("userData"), "settings.json");

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch (e) { return {}; }
}
function save(patch) {
  const next = Object.assign(load(), patch);
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(next, null, 2));
  } catch (e) { console.error("settings write failed:", e.message); }
  return next;
}

let win = null;
let tray = null;
let stream = null;
let retryMs = 1000;
let clickThrough = false;

function createWindow() {
  const saved = load();
  const area = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: saved.width || 380,
    height: saved.height || 460,
    x: saved.x != null ? saved.x : area.width - 400,
    y: saved.y != null ? saved.y : 40,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    minWidth: 280,
    minHeight: 200,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // "screen-saver" is the level that actually floats above a borderless
  // fullscreen game on Windows; plain alwaysOnTop does not.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  const remember = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    save({ x: b.x, y: b.y, width: b.width, height: b.height });
  };
  // Coming back from hidden always restores clicks. Otherwise "show" from the
  // tray returns a window you still can't interact with.
  win.on("show", () => { if (clickThrough) setClickThrough(false); });
  win.on("moved", remember);
  win.on("resized", remember);
  win.on("closed", () => { win = null; });
}

function makeTray() {
  try {
    tray = new Tray(path.join(__dirname, "renderer", "icon.png"));
  } catch (e) {
    console.warn("tray icon missing:", e.message);
    return;
  }
  tray.setToolTip("M.I.L.F Viewer");
  rebuildTrayMenu();
  tray.on("click", () => { if (win) win.isVisible() ? win.hide() : win.show(); });
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show / hide", click: () => win && (win.isVisible() ? win.hide() : win.show()) },
    { label: "Click-through  (" + TOGGLE_HOTKEY + ")", type: "checkbox", checked: clickThrough,
      click: (item) => setClickThrough(item.checked) },
    { type: "separator" },
    { label: "Clear feed", click: () => relay("clear") },
    { label: "Reset position", click: () => {
        const area = screen.getPrimaryDisplay().workAreaSize;
        if (!win) return;
        win.setBounds({ x: area.width - 400, y: 40, width: 380, height: 460 });
        win.show();
      } },
    { type: "separator" },
    { label: "Unpair", click: () => { save({ token: null }); relay("unpaired"); stop(); } },
    { label: "Quit", click: () => app.quit() }
  ]));
}

function setClickThrough(on) {
  clickThrough = on;
  if (!win) return;
  // forward:true keeps move events flowing, so the renderer can still show a
  // hint on hover even while clicks pass through.
  win.setIgnoreMouseEvents(on, { forward: true });
  relay("clickthrough", { on: on, hotkey: TOGGLE_HOTKEY });
  if (tray) tray.setToolTip("M.I.L.F Viewer" + (on ? " - click-through ON (" + TOGGLE_HOTKEY + ")" : ""));
  rebuildTrayMenu();
}

function registerHotkey() {
  const okd = globalShortcut.register(TOGGLE_HOTKEY, () => setClickThrough(!clickThrough));
  if (!okd) {
    console.warn("could not register " + TOGGLE_HOTKEY + " - another app has it");
    relay("status", { state: "hotkeyfail", detail: TOGGLE_HOTKEY });
  }
  return okd;
}

function relay(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload || {});
}

// ── SSE client ──────────────────────────────────────────────
// Hand-rolled rather than using EventSource, because a raw request can send
// an Authorization header - EventSource can't, which would force the token
// into the query string and therefore into the proxy's access log.
function connect() {
  const { serverUrl, token } = load();
  if (!serverUrl || !token) { relay("status", { state: "unpaired" }); return; }

  let target;
  try { target = new URL("/api/feed", serverUrl); }
  catch (e) { relay("status", { state: "error", detail: "bad server URL" }); return; }

  const lib = target.protocol === "https:" ? https : http;
  relay("status", { state: "connecting" });

  const req = lib.request(target, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "text/event-stream",
      "Cache-Control": "no-cache"
    }
  }, (res) => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      relay("status", { state: "unpaired", detail: "pairing rejected - pair again" });
      save({ token: null });
      res.resume();
      return;
    }
    if (res.statusCode !== 200) {
      relay("status", { state: "error", detail: "server returned " + res.statusCode });
      res.resume();
      return retry();
    }

    retryMs = 1000;                       // a good connection resets the backoff
    relay("status", { state: "live" });
    res.setEncoding("utf8");

    let buffer = "";
    res.on("data", (chunk) => {
      buffer += chunk;
      // Events are separated by a blank line; anything after the last one is
      // a partial event and must stay in the buffer.
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        handleEvent(raw);
      }
    });
    res.on("end", retry);
    res.on("error", retry);
  });

  req.on("error", (e) => {
    relay("status", { state: "offline", detail: e.message });
    retry();
  });
  req.end();
  stream = req;
}

function handleEvent(raw) {
  let event = "message", data = "";
  raw.split("\n").forEach((line) => {
    if (line.startsWith(":")) return;                 // keepalive comment
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  });
  if (!data) return;
  let parsed;
  try { parsed = JSON.parse(data); } catch (e) { return; }
  if (event === "scan") relay("scan", parsed);
  else if (event === "hello") relay("status", { state: "live", detail: parsed.name });
}

function stop() {
  if (stream) { try { stream.destroy(); } catch (e) {} stream = null; }
}

function retry() {
  stop();
  // Capped exponential backoff: a server restart shouldn't turn into a
  // reconnect storm from every open viewer.
  const wait = retryMs;
  retryMs = Math.min(retryMs * 2, 30000);
  relay("status", { state: "reconnecting", detail: Math.round(wait / 1000) + "s" });
  setTimeout(() => { if (!app.isQuiting) connect(); }, wait);
}

// ── pairing, driven from the renderer ───────────────────────
ipcMain.handle("pair", async (_e, { serverUrl, code }) => {
  let target;
  try { target = new URL("/api/viewer/claim", serverUrl); }
  catch (e) { return { ok: false, error: "That server address doesn't look right." }; }

  const lib = target.protocol === "https:" ? https : http;
  const body = JSON.stringify({ code: code });

  return new Promise((resolve) => {
    const req = lib.request(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { out += d; });
      res.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(out); } catch (e) {}
        if (res.statusCode === 200 && parsed.token) {
          save({ serverUrl: serverUrl, token: parsed.token });
          stop(); connect();
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: parsed.error || ("server returned " + res.statusCode) });
        }
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
});

ipcMain.handle("state", () => {
  const s = load();
  return { paired: !!s.token, serverUrl: s.serverUrl || "", clickThrough: clickThrough };
});
ipcMain.handle("clickthrough", (_e, on) => { setClickThrough(!!on); return clickThrough; });
ipcMain.handle("hotkey", () => TOGGLE_HOTKEY);
ipcMain.handle("close", () => app.quit());
ipcMain.handle("openExternal", (_e, url) => shell.openExternal(url));

app.on("before-quit", () => { app.isQuiting = true; stop(); });
app.on("will-quit", () => globalShortcut.unregisterAll());
app.whenReady().then(() => {
  createWindow();
  makeTray();
  registerHotkey();
  connect();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
