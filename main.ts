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

import { app, BrowserWindow, ipcMain, screen, Tray, Menu, clipboard, safeStorage } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { URL } from "node:url";
import { classify } from "./clipboard-filter";
import { CredentialStore } from "./credentials";
import { DashboardClient, type DashboardRequestFailure } from "./dashboard-client";
import { parseDashboardOrigin, type DashboardOriginResult } from "./dashboard-url";
import { FeedConnectionManager, type SseMessage } from "./feed-connection";
import { runAuthorizedIpc } from "./ipc-security";
import {
  parseBumpClearedEvent,
  parseBumpEvent,
  parseBumpResult,
  parseClaimResponse,
  parseClipboardRelayResponse,
  parseClipWatchRequest,
  parseHelloEvent,
  parseNoArguments,
  negotiateProtocol,
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
  type KnownCapability,
  type ProtocolNegotiation,
  type Settings,
  type ViewerState,
  type Vocabulary,
  PROTOCOL_CAPABILITIES,
} from "./contracts";

const STORE = path.join(app.getPath("userData"), "settings.json");
const CREDENTIAL_FILE = path.join(app.getPath("userData"), "credential.bin");
const ALLOW_INSECURE_LOCALHOST = app.commandLine.hasSwitch("allow-insecure-localhost");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let protocol: ProtocolNegotiation | null = null;
let credentials: CredentialStore | null = null;
let startupPairingDetail: string | null = null;
let networkGeneration = 0;

const SMALL_RESPONSE_LIMIT = 64 * 1024;
const VOCABULARY_RESPONSE_LIMIT = 16 * 1024 * 1024;
const VOCABULARY_RESPONSE_TIMEOUT_MS = 60_000;
const dashboardClient = new DashboardClient();
const feedConnection = new FeedConnectionManager({
  onStatus: (status) => relay("status", status),
  onEvent: (message) => handleEvent(message),
  onUnauthorized: () => { void expirePairing(); },
});

function supports(capability: KnownCapability): boolean {
  // Until a complete modern hello arrives, act like the released viewer so
  // legacy dashboards and partially rolled-out additive hellos keep working.
  if (!protocol || protocol.compatibility === "legacy") return true;
  // A newer protocol may have changed capability semantics. Its read-only
  // scan feed remains useful, but writes and clipboard relays fail closed.
  if (protocol.compatibility === "newer-protocol") return false;
  return protocol.capabilities.includes(capability);
}

function protocolStatus(name: string, negotiated: ProtocolNegotiation): ConnectionStatus {
  if (negotiated.compatibility === "fully-compatible") {
    return {
      state: "live",
      detail: name,
      compatibility: negotiated.compatibility,
      ...(negotiated.protocolVersion === undefined ? {} : { protocolVersion: negotiated.protocolVersion }),
    };
  }
  if (negotiated.compatibility === "legacy") {
    return {
      state: "warn",
      detail: "Legacy dashboard - compatibility mode",
      compatibility: negotiated.compatibility,
    };
  }
  if (negotiated.compatibility === "newer-protocol") {
    return {
      state: "warn",
      detail: `Dashboard protocol v${negotiated.protocolVersion} is newer - scan feed only`,
      compatibility: negotiated.compatibility,
      ...(negotiated.protocolVersion === undefined ? {} : { protocolVersion: negotiated.protocolVersion }),
    };
  }

  const labels: Record<KnownCapability, string> = {
    "scan-feed": "scan feed",
    "bump-control": "bumping",
    "clipboard-relay": "clipboard relay",
    "clipboard-vocabulary": "clipboard vocabulary",
    "scan-replay": "scan replay",
  };
  return {
    state: "warn",
    detail: "Limited dashboard - " + negotiated.missingCapabilities.map((capability) => labels[capability]).join(", ") + " unavailable",
    compatibility: negotiated.compatibility,
    ...(negotiated.protocolVersion === undefined ? {} : { protocolVersion: negotiated.protocolVersion }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestFailureMessage(result: DashboardRequestFailure): string {
  if (result.kind === "http") {
    const server = parseServerError(result.body);
    return server.detail || server.error || server.message || result.message;
  }
  return result.message;
}

function load(): Settings {
  try { return parseSettings(JSON.parse(fs.readFileSync(STORE, "utf8"))); } catch { return {}; }
}
function save(patch: Partial<Settings>, remove: readonly (keyof Settings)[] = []): Settings {
  const next = Object.assign(load(), patch);
  remove.forEach((key) => { delete next[key]; });
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(next, null, 2));
  } catch (error) { console.error("settings write failed:", errorMessage(error)); }
  return next;
}

function storedOrigin(serverUrl: unknown): DashboardOriginResult {
  return parseDashboardOrigin(serverUrl, ALLOW_INSECURE_LOCALHOST);
}

function session(): { serverUrl: string; token: string } | null {
  const token = credentials?.get();
  const parsed = storedOrigin(load().serverUrl);
  return token && parsed.ok ? { serverUrl: parsed.origin, token } : null;
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
  if (!supports(PROTOCOL_CAPABILITIES.clipboardVocabulary)) return;
  const auth = session();
  if (!auth) return;
  const generation = networkGeneration;
  const { serverUrl, token } = auth;
  const target = new URL("/api/viewer/vocabulary", serverUrl);
  void dashboardClient.requestJson({
    url: target,
    method: "GET",
    token,
    parse: parseVocabulary,
    maxResponseBytes: VOCABULARY_RESPONSE_LIMIT,
    responseTimeoutMs: VOCABULARY_RESPONSE_TIMEOUT_MS,
  }).then((result) => {
    if (!result.ok || generation !== networkGeneration) return;
    vocabulary = new Set(result.body.words);
    try { fs.writeFileSync(VOCAB_FILE(), JSON.stringify(result.body)); } catch { /* keep the in-memory copy */ }
    relay("clipwatch", { on: clipboardWatching(), stats: clipStats,
                         vocabulary: vocabulary.size });
  });
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
  if (!supports(PROTOCOL_CAPABILITIES.clipboardRelay)) {
    relay("clipwatch", { on: clipboardWatching(), stats: clipStats, error: "dashboard does not advertise clipboard relay" });
    return;
  }
  const auth = session();
  if (!auth) return;
  const generation = networkGeneration;
  const { serverUrl, token } = auth;
  const target = new URL("/api/viewer/clip", serverUrl);
  void dashboardClient.requestJson({
    url: target,
    method: "POST",
    token,
    body: clip,
    parse: parseClipboardRelayResponse,
    maxResponseBytes: SMALL_RESPONSE_LIMIT,
  }).then((result) => {
    if (generation !== networkGeneration || (!result.ok && result.kind === "cancelled")) return;
    if (!result.ok && result.kind !== "http") {
      relay("clipwatch", { on: true, stats: clipStats, error: requestFailureMessage(result) });
      return;
    }
    clipStats.sent += 1;
    clipStats.lastKind = clip.kind;
    clipStats.lastAt = Date.now();
    // delivered === 0 means no dashboard tab is open to receive it, which is
    // worth saying rather than looking like it silently worked.
    relay("clipwatch", {
      on: true,
      stats: clipStats,
      sentKind: clip.kind,
      delivered: result.ok ? result.body.delivered : null,
      error: result.ok ? null : requestFailureMessage(result),
    });
  });
}

function relay<K extends keyof IpcEventContract>(channel: K, payload: IpcEventContract[K]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ── SSE client ──────────────────────────────────────────────
// Hand-rolled rather than EventSource, because a raw request can send an
// Authorization header - EventSource can't, which would force the token into
// the query string and therefore into the proxy's access log.
function connect(): void {
  const auth = session();
  if (!auth) {
    relay("status", startupPairingDetail
      ? { state: "unpaired", detail: startupPairingDetail }
      : { state: "unpaired" });
    return;
  }
  feedConnection.start(auth);
}

function handleEvent({ event, data, id }: SseMessage): boolean {
  if (!data) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return false; }
  if (event === "scan") {
    const scan = parseScan(parsed);
    if (!scan || (id !== undefined && id !== scan.id)) return false;
    relay("scan", scan);
    return true;
  } else if (event === "bump") {
    const bump = parseBumpEvent(parsed);
    if (!bump) return false;
    relay("bump", bump);
    return true;
  } else if (event === "bumpCleared") {
    const cleared = parseBumpClearedEvent(parsed);
    if (!cleared) return false;
    relay("bumpCleared", cleared);
    return true;
  } else if (event === "hello") {
    const hello = parseHelloEvent(parsed);
    if (hello) {
      protocol = negotiateProtocol(hello);
      const replaySupported = protocol.compatibility !== "legacy" &&
        protocol.compatibility !== "newer-protocol" &&
        protocol.capabilities.includes(PROTOCOL_CAPABILITIES.scanReplay);
      feedConnection.setReplayEnabled(replaySupported);
      const clipboardSupported = supports(PROTOCOL_CAPABILITIES.clipboardRelay) &&
        supports(PROTOCOL_CAPABILITIES.clipboardVocabulary);
      if (clipboardSupported) {
        if (clipboardWatching()) startClipWatch();
      } else {
        stopClipWatch();
        relay("clipwatch", {
          on: false,
          stats: clipStats,
          error: "dashboard does not advertise clipboard support",
        });
      }
      // Send this last so the persistent compatibility warning remains the
      // visible status if disabling an armed clipboard watcher also emitted an
      // explanatory clipboard event.
      const status = protocolStatus(hello.name, protocol);
      if (replaySupported && hello.replay?.status === "cursor-expired") {
        status.state = "warn";
        status.detail = "Replay history expired - showing retained scans";
      }
      relay("status", status);
      return true;
    }
  }
  return false;
}

function stop(): void {
  feedConnection.stop();
}

async function expirePairing(): Promise<void> {
  networkGeneration += 1;
  dashboardClient.cancelAll();
  protocol = null;
  await credentials?.clear();
  relay("status", { state: "unpaired", detail: "pairing expired - pair again" });
}

// ── ipc ─────────────────────────────────────────────────────
type InvokeChannel = keyof IpcInvokeContract;

function handleIpc<K extends InvokeChannel>(
  channel: K,
  rejected: () => IpcInvokeContract[K]["result"],
  handler: (event: IpcMainInvokeEvent, request: unknown) => IpcInvokeContract[K]["result"] | Promise<IpcInvokeContract[K]["result"]>,
): void {
  ipcMain.handle(channel, async (event, request: unknown) => {
    const webContents = win && !win.isDestroyed() ? win.webContents : null;
    return runAuthorizedIpc(event, webContents, rejected, async () => handler(event, request));
  });
}

handleIpc("pair", () => ({ ok: false, error: "Request rejected." }), async (_event, input): Promise<PairResult> => {
  const request = parsePairRequest(input);
  if (!request) return { ok: false, error: "Both server address and pairing code are required." };
  const { serverUrl, code } = request;
  const parsedOrigin = storedOrigin(serverUrl);
  if (!parsedOrigin.ok) return { ok: false, error: parsedOrigin.error };
  const target = new URL("/api/viewer/claim", parsedOrigin.origin);
  const result = await dashboardClient.requestJson({
    url: target,
    method: "POST",
    body: { code },
    parse: parseClaimResponse,
    maxResponseBytes: SMALL_RESPONSE_LIMIT,
  });
  if (!result.ok) return { ok: false, error: requestFailureMessage(result) };
  if (!credentials || !await credentials.set(result.body.token)) {
    return { ok: false, error: "Secure credential storage is unavailable. Pair again after it is restored." };
  }

  networkGeneration += 1;
  dashboardClient.cancelAll();
  stop();
  save({ serverUrl: parsedOrigin.origin }, ["token"]);
  startupPairingDetail = null;
  protocol = null;
  vocabulary = null;
  fetchVocabulary();
  connect();
  return { ok: true };
});

// Forget the token and show the pairing screen. Reachable from the header and
// the tray at ALL times - not only when the server happens to reject us.
// Otherwise a stale token plus an unreachable server leaves no way back in.
handleIpc("unpair", () => false, async (_event, input) => {
  if (!parseNoArguments(input)) return false;
  networkGeneration += 1;
  dashboardClient.cancelAll();
  stop();
  protocol = null;
  startupPairingDetail = null;
  await credentials?.clear();
  save({}, ["token"]);
  relay("unpaired", undefined);
  relay("status", { state: "unpaired" });
  return true;
});

handleIpc("state", (): ViewerState => ({ paired: false, serverUrl: "", opacity: 1 }), (_event, input): ViewerState => {
  if (!parseNoArguments(input)) return { paired: false, serverUrl: "", opacity: 1 };
  const s = load();
  return {
    paired: !!credentials?.get(),
    serverUrl: s.serverUrl || "",
    // 0 solid / 1 default / 2 faint. The renderer applies it as a CSS class.
    opacity: s.opacity == null ? 1 : s.opacity
  };
});

handleIpc("opacity", () => 1, (_event, level) => {
  const n = parseOpacity(level);
  if (n === null) return load().opacity ?? 1;
  save({ opacity: n });
  return n;
});

// Bumping is the viewer's only write. It goes out with the same bearer token
// the feed uses, so a paired viewer can bump and an unpaired one cannot.
handleIpc("bump", () => ({ ok: false, error: "Request rejected." }), async (_event, input): Promise<BumpResult> => {
  const scanId = parseScanId(input);
  if (scanId === null) return { ok: false, error: "invalid scan" };
  const auth = session();
  if (!auth) return { ok: false, error: "not paired" };
  const { serverUrl, token } = auth;
  if (!supports(PROTOCOL_CAPABILITIES.bumpControl)) {
    return { ok: false, error: "This dashboard does not advertise bump control." };
  }
  const target = new URL("/api/viewer/bump", serverUrl);
  const result = await dashboardClient.requestJson({
    url: target,
    method: "POST",
    token,
    body: { scanId },
    parse: parseBumpResult,
    maxResponseBytes: SMALL_RESPONSE_LIMIT,
  });
  // The timer itself arrives over the feed, not from this response, so the
  // bumper sees exactly what everyone else sees at the same time.
  if (result.ok) return result.body;

  const failure = parseServerError(result.body);
  // A 404 has two very different causes and they need different advice.
  // Fastify's own not-found handler emits {error:"Not Found", message:
  // "Route POST:/api/viewer/bump not found"} - that means the DASHBOARD
  // predates bumping. Our handler emits {error:"unknown_scan"}, which
  // means the scan aged out of the feed. Reporting both as "Not Found"
  // sends people looking in the wrong place.
  if (result.kind === "http" && result.status === 404 && !failure.detail &&
      /not found/i.test(failure.message || "")) {
    return {
      ok: false,
      error: "This dashboard doesn't support bumping yet - it needs updating."
    };
  }
  return { ok: false, error: failure.detail || failure.error || requestFailureMessage(result) };
});

handleIpc("clipwatch", () => ({
  on: false,
  stats: clipStats,
  error: "Request rejected.",
}), (_event, input): ClipboardResult => {
  const on = parseClipWatchRequest(input);
  if (on === null) return { on: clipboardWatching(), stats: clipStats, error: "invalid clipboard setting" };
  if (on === undefined) {
    return { on: clipboardWatching(), stats: clipStats,
             vocabulary: vocabulary ? vocabulary.size : 0 };
  }
  if (on && (!supports(PROTOCOL_CAPABILITIES.clipboardRelay) ||
             !supports(PROTOCOL_CAPABILITIES.clipboardVocabulary))) {
    return {
      on: clipboardWatching(),
      stats: clipStats,
      error: "dashboard does not advertise clipboard support",
    };
  }
  if (on && !vocabulary) fetchVocabulary();
  setClipboardWatching(on);
  return { on: clipboardWatching(), stats: clipStats };
});

handleIpc("close", () => undefined, (_event, input) => {
  if (parseNoArguments(input)) app.quit();
});

async function initializeSecurityState(): Promise<void> {
  credentials = new CredentialStore(CREDENTIAL_FILE, safeStorage);
  const settings = load();
  const initialized = await credentials.initialize(settings.token);
  if (initialized.removeLegacyToken) save({}, ["token"]);

  if (initialized.status === "unavailable") {
    startupPairingDetail = "Secure credential storage is unavailable - pair again after it is restored.";
  } else if (initialized.status === "corrupt") {
    startupPairingDetail = "The stored pairing could not be unlocked - pair again.";
  }

  if (settings.serverUrl) {
    const parsed = storedOrigin(settings.serverUrl);
    if (parsed.ok) {
      if (parsed.origin !== settings.serverUrl) save({ serverUrl: parsed.origin }, ["token"]);
    } else if (credentials.get()) {
      await credentials.clear();
      startupPairingDetail = "The stored dashboard address is no longer allowed - pair again.";
    }
  } else if (credentials.get()) {
    await credentials.clear();
    startupPairingDetail = "The stored pairing is incomplete - pair again.";
  }
}

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
    networkGeneration += 1;
    dashboardClient.cancelAll();
    stop();
    stopClipWatch();
    if (tray) { tray.destroy(); tray = null; }
  });

  app.on("window-all-closed", () => app.quit());

  app.whenReady().then(async () => {
    await initializeSecurityState();
    createWindow();
    makeTray();
    connect();
    loadVocabulary();
    fetchVocabulary();          // refresh in the background; cache covers the gap
    if (clipboardWatching()) startClipWatch();
  });
}
