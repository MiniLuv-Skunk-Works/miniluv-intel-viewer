"use strict";
// MILF Viewer - MiniLuv Intel Live Feed
//
// A borderless always-on-top window that sits over EVE and shows scans as they
// are posted. Deliberately NOT an injected overlay: hooking DirectX to draw
// inside the game client is the pattern CCP's EULA prohibits, and no
// convenience is worth a SIG-wide ban. This is an ordinary window that floats.
//
// Works with windowed and borderless-fullscreen EVE. Exclusive fullscreen will
// cover it, which is the cost of not injecting.

import { app, BrowserWindow, ipcMain, screen, Tray, Menu, clipboard } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";
import { classify } from "./clipboard-filter";
import {
  parseBumpClearedEvent,
  parseBumpEvent,
  parseClaimResponse,
  parseClipWatchRequest,
  parseHelloEvent,
  parseOpacity,
  parsePairRequest,
  parseScan,
  parseScanId,
  parseServerError,
  parseSettings,
  parseVocabulary,
  type BumpResult,
  type ClipboardCapture,
  type ClipboardKind,
  type ClipboardResult,
  type ClipboardStats,
  type ConnectionStatus,
  type IpcEventContract,
  type IpcInvokeContract,
  type PairResult,
  type Settings,
  type ViewerState,
  type Vocabulary,
} from "./contracts";

const STORE = path.join(app.getPath("userData"), "settings.json");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let stream: http.ClientRequest | null = null;
let retryMs = 1000;
let quitting = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function load(): Settings {
  try { return parseSettings(JSON.parse(fs.readFileSync(STORE, "utf8"))); } catch { return {}; }
}
function save(patch: Partial<Settings>): Settings {
  const next = Object.assign(load(), patch);
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(next, null, 2));
  } catch (error) { console.error("settings write failed:", errorMessage(error)); }
  return next;
}

function createWindow(): void {
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
    alwaysOnTop: true,
    minWidth: 280,
    minHeight: 200,
    // The RUNNING window's taskbar icon. Separate from the exe icon that
    // electron-builder stamps in - setting win.icon in the build config does
    // nothing for this, which is why it still showed the Electron default.
    //
    // Must be a file inside build.files, or it won't exist in the packaged app.
    // build/ is buildResources - available to the builder, not to the app.
    icon: path.join(__dirname, "..", "renderer", "icon-256.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron defaults this to true when nodeIntegration is off, but it is
      // set explicitly so a future config change can't silently drop it. The
      // renderer displays content from a server we do not control, so it gets
      // the OS-level sandbox as well as context isolation.
      sandbox: true,
      // Nothing here needs to open another window, and a server-driven
      // window.open would be a way out of the CSP.
      webviewTag: false
    }
  });

  // "screen-saver" is the level that actually floats above a borderless
  // fullscreen game on Windows; plain alwaysOnTop does not.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // The renderer only ever shows the local page. Any attempt to navigate away
  // or spawn a window is either a bug or an attack, so both are refused
  // outright rather than filtered.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());

  const remember = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    save({ x: b.x, y: b.y, width: b.width, height: b.height });
  };
  win.on("moved", remember);
  win.on("resized", remember);

  // Closing the window ends the app. A tray-only survivor is exactly how you
  // end up with a process you can't see, holding its temp directory open so
  // the next `npm run build` fails.
  win.on("closed", () => { win = null; if (!quitting) app.quit(); });
}

function makeTray(): void {
  try {
    tray = new Tray(path.join(__dirname, "..", "renderer", "icon.png"));
  } catch (error) {
    console.warn("tray icon missing:", errorMessage(error));
    return;
  }
  tray.setToolTip("MILF Viewer");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show", click: () => { if (win) { win.show(); win.focus(); } } },
    { label: "Clear feed", click: () => relay("clear", undefined) },
    { label: "Watch clipboard", type: "checkbox", checked: clipboardWatching(),
      click: (item) => setClipboardWatching(item.checked) },
    { type: "separator" },
    { label: "Re-pair\u2026", click: () => relay("repair", undefined) },
    { label: "Reset position", click: () => {
        if (!win) return;
        const area = screen.getPrimaryDisplay().workAreaSize;
        win.setBounds({ x: area.width - 400, y: 40, width: 380, height: 460 });
        win.show();
      } },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() }
  ]));
  tray.on("click", () => { if (win) { win.show(); win.focus(); } });
}

// ── clipboard watching ──────────────────────────────────────
// Electron has no clipboard-change event on Windows, so this polls. 500ms is
// under human reaction time between copying and looking at the dashboard, and
// reading the clipboard is cheap.
//
// OFF by default and remembered per machine. Reading someone's clipboard is
// not a thing to switch on for them.
const CLIP_POLL_MS = 500;
let clipTimer: NodeJS.Timeout | null = null;
let lastClip = "";
let clipStats: ClipboardStats = { sent: 0, ignored: 0, lastKind: null, lastAt: 0 };

// EVE's item vocabulary, fetched from the dashboard and cached. The filter
// refuses to send anything until this arrives - see clipboard-filter.ts.
let vocabulary: Set<string> | null = null;
const VOCAB_FILE = (): string => path.join(app.getPath("userData"), "vocabulary.json");

function loadVocabulary(): number | null {
  try {
    const raw = parseVocabulary(JSON.parse(fs.readFileSync(VOCAB_FILE(), "utf8")));
    if (raw) {
      vocabulary = new Set(raw.words);
      return raw.buildNumber ?? null;
    }
  } catch { /* first run, or the cache is unreadable */ }
  return null;
}

function fetchVocabulary(): void {
  const { serverUrl, token } = load();
  if (!serverUrl || !token) return;
  let target;
  try { target = new URL("/api/viewer/vocabulary", serverUrl); } catch { return; }
  const lib = target.protocol === "https:" ? https : http;
  const req = lib.request(target, {
    method: "GET", headers: { Authorization: "Bearer " + token }
  }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return; }
    let out = "";
    res.setEncoding("utf8");
    res.on("data", d => { out += d; });
    res.on("end", () => {
      try {
        const parsed = parseVocabulary(JSON.parse(out));
        if (!parsed) return;
        vocabulary = new Set(parsed.words);
        fs.writeFileSync(VOCAB_FILE(), JSON.stringify(parsed));
        relay("clipwatch", { on: clipboardWatching(), stats: clipStats,
                             vocabulary: vocabulary.size });
      } catch { /* leave the cached one in place */ }
    });
  });
  req.on("error", () => {});
  req.end();
}

function clipboardWatching(): boolean {
  return !!load().watchClipboard;
}

function setClipboardWatching(on: boolean): void {
  save({ watchClipboard: !!on });
  if (on) startClipWatch();
  else stopClipWatch();
  relay("clipwatch", { on: !!on, stats: clipStats });
}

function startClipWatch(): void {
  if (clipTimer) return;
  // Seed with whatever is already on the clipboard so switching the feature on
  // doesn't immediately fire off something copied ten minutes ago.
  try { lastClip = clipboard.readText(); } catch { lastClip = ""; }
  clipTimer = setInterval(pollClipboard, CLIP_POLL_MS);
}

function stopClipWatch(): void {
  if (clipTimer) { clearInterval(clipTimer); clipTimer = null; }
}

function pollClipboard(): void {
  let text;
  try { text = clipboard.readText(); } catch { return; }
  if (!text || text === lastClip) return;
  lastClip = text;

  // Everything the classifier rejects stops here and never touches the network.
  const clip = classify(text, vocabulary);
  if (!clip) {
    clipStats.ignored += 1;
    // Distinguish "not EVE data" from "cannot tell yet", or the feature looks
    // broken on first run rather than merely not ready.
    if (!vocabulary) fetchVocabulary();
    relay("clipwatch", { on: true, stats: clipStats, ignored: true });
    return;
  }
  sendClip(clip);
}

function sendClip(clip: ClipboardCapture): void {
  const { serverUrl, token } = load();
  if (!serverUrl || !token) return;
  let target;
  try { target = new URL("/api/viewer/clip", serverUrl); } catch { return; }

  const lib = target.protocol === "https:" ? https : http;
  const body = JSON.stringify(clip);
  const req = lib.request(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Authorization: "Bearer " + token
    }
  }, (res) => {
    let out = "";
    res.setEncoding("utf8");
    res.on("data", d => { out += d; });
    res.on("end", () => {
      let parsed: unknown = {};
      try { parsed = JSON.parse(out); } catch {}
      const response = parseServerError(parsed);
      const responseRecord = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown> : {};
      const delivered = typeof responseRecord.delivered === "number" && Number.isFinite(responseRecord.delivered)
        ? responseRecord.delivered : 0;
      clipStats.sent += 1;
      clipStats.lastKind = clip.kind;
      clipStats.lastAt = Date.now();
      // delivered === 0 means no dashboard tab is open to receive it, which is
      // worth saying rather than looking like it silently worked.
      relay("clipwatch", {
        on: true, stats: clipStats, sentKind: clip.kind,
        delivered: res.statusCode === 200 ? delivered : null,
        error: res.statusCode === 200 ? null : (response.error || "HTTP " + res.statusCode)
      });
    });
  });
  req.on("error", (e) => relay("clipwatch", { on: true, stats: clipStats, error: e.message }));
  req.write(body);
  req.end();
}

function relay<K extends keyof IpcEventContract>(channel: K, payload: IpcEventContract[K]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ── SSE client ──────────────────────────────────────────────
// Hand-rolled rather than EventSource, because a raw request can send an
// Authorization header - EventSource can't, which would force the token into
// the query string and therefore into the proxy's access log.
function connect(): void {
  const { serverUrl, token } = load();
  if (!serverUrl || !token) { relay("status", { state: "unpaired" }); return; }

  let target;
  try { target = new URL("/api/feed", serverUrl); }
  catch { relay("status", { state: "error", detail: "bad server address" }); return; }

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
      // The token is dead. Clear it and say so, rather than retrying forever
      // against a server that will never accept it.
      save({ token: null });
      relay("status", { state: "unpaired", detail: "pairing expired - pair again" });
      res.resume();
      return;
    }
    if (res.statusCode !== 200) {
      relay("status", { state: "error", detail: "server returned " + res.statusCode });
      res.resume();
      return retry();
    }

    retryMs = 1000;
    relay("status", { state: "live" });
    res.setEncoding("utf8");

    let buffer = "";
    res.on("data", (chunk) => {
      buffer += chunk;
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

function handleEvent(raw: string): void {
  let event = "message", data = "";
  raw.split("\n").forEach((line) => {
    if (line.startsWith(":")) return;                 // keepalive comment
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  });
  if (!data) return;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return; }
  if (event === "scan") {
    const scan = parseScan(parsed);
    if (scan) relay("scan", scan);
  } else if (event === "bump") {
    const bump = parseBumpEvent(parsed);
    if (bump) relay("bump", bump);
  } else if (event === "bumpCleared") {
    const cleared = parseBumpClearedEvent(parsed);
    if (cleared) relay("bumpCleared", cleared);
  } else if (event === "hello") {
    const hello = parseHelloEvent(parsed);
    if (hello) relay("status", { state: "live", detail: hello.name });
  }
}

function stop(): void {
  if (stream) { try { stream.destroy(); } catch {} stream = null; }
}

function retry(): void {
  stop();
  if (quitting) return;
  const wait = retryMs;
  retryMs = Math.min(retryMs * 2, 30000);
  relay("status", { state: "reconnecting", detail: Math.round(wait / 1000) + "s" });
  setTimeout(() => { if (!quitting) connect(); }, wait);
}

// ── ipc ─────────────────────────────────────────────────────
type InvokeChannel = keyof IpcInvokeContract;

function handleIpc<K extends InvokeChannel>(
  channel: K,
  handler: (event: IpcMainInvokeEvent, request: unknown) => IpcInvokeContract[K]["result"] | Promise<IpcInvokeContract[K]["result"]>,
): void {
  ipcMain.handle(channel, handler);
}

handleIpc("pair", async (_event, input): Promise<PairResult> => {
  const request = parsePairRequest(input);
  if (!request) return { ok: false, error: "Both server address and pairing code are required." };
  const { serverUrl, code } = request;
  let target;
  try { target = new URL("/api/viewer/claim", serverUrl); }
  catch { return { ok: false, error: "That server address doesn't look right." }; }

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
      let parsed: unknown = {};
      try { parsed = JSON.parse(out); } catch {}
      const claim = parseClaimResponse(parsed);
      const failure = parseServerError(parsed);
      if (res.statusCode === 200 && claim) {
          save({ serverUrl: serverUrl, token: claim.token });
          vocabulary = null;
          fetchVocabulary();
          retryMs = 1000;
          stop(); connect();
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: failure.error || ("server returned " + res.statusCode) });
        }
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
});

// Forget the token and show the pairing screen. Reachable from the header and
// the tray at ALL times - not only when the server happens to reject us.
// Otherwise a stale token plus an unreachable server leaves no way back in.
handleIpc("unpair", () => {
  stop();
  save({ token: null });
  relay("unpaired", undefined);
  relay("status", { state: "unpaired" });
  return true;
});

handleIpc("state", (): ViewerState => {
  const s = load();
  return {
    paired: !!s.token,
    serverUrl: s.serverUrl || "",
    // 0 solid / 1 default / 2 faint. The renderer applies it as a CSS class.
    opacity: s.opacity == null ? 1 : s.opacity
  };
});

handleIpc("opacity", (_event, level) => {
  const n = parseOpacity(level);
  save({ opacity: n });
  return n;
});

// Bumping is the viewer's only write. It goes out with the same bearer token
// the feed uses, so a paired viewer can bump and an unpaired one cannot.
handleIpc("bump", async (_event, input): Promise<BumpResult> => {
  const scanId = parseScanId(input);
  if (scanId === null) return { ok: false, error: "invalid scan" };
  const { serverUrl, token } = load();
  if (!serverUrl || !token) return { ok: false, error: "not paired" };
  let target;
  try { target = new URL("/api/viewer/bump", serverUrl); }
  catch { return { ok: false, error: "bad server address" }; }

  const lib = target.protocol === "https:" ? https : http;
  const body = JSON.stringify({ scanId: scanId });
  return new Promise((resolve) => {
    const req = lib.request(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer " + token
      }
    }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", d => { out += d; });
      res.on("end", () => {
        // The timer itself arrives over the feed, not from this response -
        // so the bumper sees exactly what everyone else sees, at the same time.
        if (res.statusCode === 200) return resolve({ ok: true });
        let parsed: unknown = {};
        try { parsed = JSON.parse(out); } catch {}
        const failure = parseServerError(parsed);

        // A 404 has two very different causes and they need different advice.
        // Fastify's own not-found handler emits {error:"Not Found", message:
        // "Route POST:/api/viewer/bump not found"} - that means the DASHBOARD
        // predates bumping. Our handler emits {error:"unknown_scan"}, which
        // means the scan aged out of the feed. Reporting both as "Not Found"
        // sends people looking in the wrong place.
        if (res.statusCode === 404 && !failure.detail &&
            /not found/i.test(failure.message || "")) {
          return resolve({
            ok: false,
            error: "This dashboard doesn't support bumping yet - it needs updating."
          });
        }
        resolve({ ok: false, error: failure.detail || failure.error || ("HTTP " + res.statusCode) });
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
});

handleIpc("clipwatch", (_event, input): ClipboardResult => {
  const on = parseClipWatchRequest(input);
  if (on === null) return { on: clipboardWatching(), stats: clipStats, error: "invalid clipboard setting" };
  if (on === undefined) {
    return { on: clipboardWatching(), stats: clipStats,
             vocabulary: vocabulary ? vocabulary.size : 0 };
  }
  if (on && !vocabulary) fetchVocabulary();
  setClipboardWatching(on);
  return { on: clipboardWatching(), stats: clipStats };
});

handleIpc("close", () => { app.quit(); });

// ── lifecycle ───────────────────────────────────────────────
// Without a single-instance lock, launching again while one is running gives
// two processes fighting over the same window position - and leaves file
// handles that make the next `npm run build` fail with EBUSY on dist/.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) { win.show(); win.focus(); }
  });

  app.on("before-quit", () => {
    quitting = true;
    stop();
    stopClipWatch();
    if (tray) { tray.destroy(); tray = null; }
  });

  app.on("window-all-closed", () => app.quit());

  app.whenReady().then(() => {
    createWindow();
    makeTray();
    connect();
    loadVocabulary();
    fetchVocabulary();          // refresh in the background; cache covers the gap
    if (clipboardWatching()) startClipWatch();
  });
}
