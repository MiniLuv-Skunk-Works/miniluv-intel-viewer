// Every field a compromised dashboard controls must reach the DOM escaped or
// coerced. This walks the renderer looking for the pattern that bit us twice.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

const ROOT = path.resolve(__dirname, "..", "..");
const app = fs.readFileSync(path.join(ROOT, ".build", "renderer", "app.js"), "utf8");
const appSource = fs.readFileSync(path.join(ROOT, "renderer", "app.ts"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "main.ts"), "utf8");
const feedConnection = fs.readFileSync(path.join(ROOT, "feed-connection.ts"), "utf8");

let pass = 0, fail = 0;
const ok = (name: string, condition: unknown, detail?: unknown): void => {
  if (condition) { pass += 1; console.log("  PASS  " + name); }
  else { fail += 1; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail) : "")); }
};

console.log("\n=== hostile scan rendered ===");
// Pattern-matching the source for missed esc() calls kept flagging safe code.
// Rendering a poisoned scan and inspecting the actual output is exact: either
// executable markup comes out or it doesn't.
const PAYLOAD = '"><img src=x onerror=ATTACK()><script>ATTACK()</script>';
const hostile: Record<string, unknown> = {
  id: PAYLOAD, at: '1" onmouseover="ATTACK()" x="', scout: PAYLOAD, hull: PAYLOAD,
  system: PAYLOAD, pilot: PAYLOAD, scanGate: PAYLOAD, headGate: PAYLOAD,
  ammo: PAYLOAD, sec: PAYLOAD, prepped: PAYLOAD, notes: PAYLOAD,
  valueSell: PAYLOAD, valueBuy: PAYLOAD, valueSplit: PAYLOAD, droppableSplit: PAYLOAD,
  ehp: PAYLOAD, fitEft: PAYLOAD,
  fleetAll: [{ name: PAYLOAD, ships: PAYLOAD }],
  cargoList: [{ name: PAYLOAD, qty: PAYLOAD }],
};

const captured: string[] = [];
interface FakeElement {
  _html?: string;
  _s: Set<string>;
  value: string;
  textContent: string;
  style: Record<string, string>;
  disabled: boolean;
  innerHTML: string;
  className?: string;
  classList: {
    add(): void; remove(): void; toggle(): void; contains(): boolean;
  };
  addEventListener(): void;
  querySelector(): FakeElement;
  querySelectorAll(): FakeElement[];
  getAttribute(): string;
  hasAttribute(): boolean;
  setAttribute(): void;
}
function el(): FakeElement {
  return {
    _s: new Set(), value: "", textContent: "", style: {}, disabled: false,
    set innerHTML(v) { captured.push(String(v)); this._html = String(v); },
    get innerHTML() { return this._html || ""; },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, querySelector: () => el(), querySelectorAll: () => [],
    getAttribute: () => "", hasAttribute: () => false, setAttribute() {},
  };
}
const nodes: Record<string, FakeElement> = {};
const testDocument = {
  getElementById: (id: string) => (nodes[id] = nodes[id] || el()),
  querySelector: () => el(), querySelectorAll: () => [],
  addEventListener() {}, body: el(), createElement: el,
};
interface TestMilf {
  _scan?: (value: unknown) => void;
  onScan(fn: (value: unknown) => void): void;
  onStatus(): void; onClear(): void; onRepair(): void; onBump(): void;
  onBumpCleared(): void; onUnpaired(): void; onClipWatch(): void;
  clipwatch(): Promise<{ on: boolean; stats: Record<string, unknown> }>;
  state(): Promise<{ paired: boolean; serverUrl: string; opacity: number }>;
  bump(): Promise<{ ok: boolean }>;
  pair(): Promise<{ ok: boolean }>;
  unpair(): Promise<boolean>;
  setOpacity(): void;
  quit(): void;
}
const testMilf: TestMilf = {
  onScan(fn) { this._scan = fn; }, onStatus() {}, onClear() {},
  onRepair() {}, onBump() {}, onBumpCleared() {}, onUnpaired() {}, onClipWatch() {},
  clipwatch: () => Promise.resolve({ on: false, stats: {} }),
  state: () => Promise.resolve({ paired: true, serverUrl: "", opacity: 1 }),
  bump: () => Promise.resolve({ ok: true }), pair: () => Promise.resolve({ ok: true }),
  unpair: () => Promise.resolve(true), setOpacity() {}, quit() {},
};
const testWindow = { milf: testMilf };

vm.runInNewContext(app, {
  document: testDocument,
  window: testWindow,
  Element: Object,
  performance: { now: () => 0 },
  setInterval: () => 0,
  clearInterval: () => undefined,
  setTimeout: () => 0,
  clearTimeout: () => undefined,
  console,
});
testMilf._scan?.(hostile);            // deliver the poisoned scan
const out = captured.join("\n");

ok("something was actually rendered", out.length > 0, "test would pass vacuously otherwise");
ok("no script tag survives", !/<script/i.test(out), out.slice(0, 160));
// Matching the raw string is wrong: an escaped payload legitimately CONTAINS
// the text " onerror=" while being completely inert. What matters is whether
// a real tag or a real attribute was created, so parse the output instead.
const TEMPLATE_TAGS = new Set(["div", "span", "button", "b", "i", "pre", "h3", "br"]);
const tags = [...out.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)];
const foreign = [...new Set(tags.map(t => (t[1] ?? "").toLowerCase()))].filter(t => !TEMPLATE_TAGS.has(t));
ok("only tags the template itself emits", foreign.length === 0, foreign.join(", "));

// Attribute NAMES, not any text inside a tag. An escaped payload sitting in
// data-id="&lt;img ... onerror=..." legitimately contains the characters
// " onerror=" while being completely inert, and matching raw text flags it.
// Quotes inside values are escaped to &quot;, so this parse is unambiguous.
const attrNames = tags.flatMap(t =>
  [...(t[2] ?? "").matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*"/g)].map(a => (a[1] ?? "").toLowerCase()));
const handlers = attrNames.filter(n => /^on/.test(n));
ok("no event handler attribute on any real tag", handlers.length === 0, handlers.join(", "));
ok("attribute names are only the ones the template writes",
   attrNames.every(n => ["class", "style", "title", "data-at", "data-id",
                         "data-bump", "data-bumprow", "data-row", "src"].includes(n)),
   [...new Set(attrNames)].join(", "));

ok("the payload survives as text, not markup",
   out.includes("&lt;img") && !out.includes("<img"),
   "escaped is fine - it should be readable and inert");
ok("attribute boundaries intact",
   !tags.some(t => /onmouseover/i.test(t[2] ?? "")),
   "s.at must not be able to close its own attribute");

console.log("\n=== the two that were exploitable ===");
ok("s.at is coerced, not interpolated raw",
   /data-at="' \+ \(Number\(s\.at\) \|\| 0\)/.test(appSource),
   "was: data-at=\"' + s.at + '\" - closed the attribute early");
ok("f.ships is escaped in the detail popup",
   /esc\(String\(f\.ships\)\.padStart/.test(appSource),
   "was raw; a tag in it went straight into the DOM");

console.log("\n=== an escaping slip should not be executable ===");
ok("no inline script left in the page", !/<script>[\s\S]*\S[\s\S]*<\/script>/.test(html));
ok("script loaded from compiled output", /<script src="\.\.\/\.build\/renderer\/app\.js">/.test(html));
ok("CSP forbids inline script", /script-src 'self'/.test(html) &&
   !/script-src[^;]*unsafe-inline/.test(html),
   "this is what downgrades an escaping bug to a cosmetic glitch");
ok("CSP blocks all outbound loads", /default-src 'none'/.test(html));
ok("CSP blocks network from the renderer", /connect-src 'none'/.test(html));

console.log("\n=== renderer containment ===");
ok("context isolation on", /contextIsolation: true/.test(main));
ok("node integration off", /nodeIntegration: false/.test(main));
ok("OS sandbox set explicitly", /sandbox: true/.test(main),
   "defaulted on, but explicit survives a future config edit");
ok("new windows denied", /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/.test(main));
ok("navigation away refused", /will-navigate[\s\S]{0,60}preventDefault/.test(main));
ok("webview tag disabled", /webviewTag: false/.test(main));

console.log("\n=== the bridge is the only way out, and it is narrow ===");
const exposed = [...main.matchAll(/handleIpc\("(\w+)"/g)].map(x => x[1]);
console.log("    reachable from the renderer: " + exposed.join(", "));
ok("no shell access exposed", !/shell\./.test(main));
// Only the ipcMain.handle bodies are reachable from page script; save() and
// the SSE client are main-process code the renderer cannot invoke.
const handlerBodies = [...main.matchAll(/handleIpc\("(\w+)",[\s\S]*?\n\}\);/g)]
  .map(x => x[0]).join("\n");
ok("no process spawning reachable from the renderer",
   !/child_process|spawn\(|execFile|exec\(/.test(handlerBodies));
ok("no arbitrary filesystem write reachable from the renderer",
   !/writeFileSync\(|unlink|rmSync/.test(handlerBodies),
   "settings are written by save(), which takes no renderer-supplied path");
const stateBody = (main.match(/handleIpc\("state"[\s\S]*?\n\}\);/) || [""])[0] ?? "";
ok("state() reports pairing as a boolean, never the token itself",
   /paired: !!credentials\?\.get\(\)/.test(stateBody) && !/token: /.test(stateBody),
   "page script must not be able to read the credential");
ok("credentials use asynchronous OS storage",
   /CredentialStore/.test(main) && /safeStorage/.test(main) && /credential\.bin/.test(main));
ok("settings token is migration-only and removed",
   /credentials\.initialize\(settings\.token\)/.test(main) &&
   /initialized\.removeLegacyToken\) save\(\{\}, \["token"\]\)/.test(main) &&
   !/save\(\{[^}]*token:/.test(main));
ok("authentication expiry clears encrypted credentials",
   /status === 401 \|\| status === 403[\s\S]{0,180}onUnauthorized\(\)/.test(feedConnection) &&
   /async function expirePairing[\s\S]{0,220}credentials\?\.clear\(\)/.test(main));
ok("all authenticated requests read the validated session",
   (main.match(/const auth = session\(\)/g) || []).length === 4 &&
   !/\{ serverUrl, token \} = load\(\)/.test(main));
ok("IPC is restricted to the viewer main frame",
   /runAuthorizedIpc\(event, webContents/.test(main));

console.log("\n" + (fail === 0 ? "ALL " + pass + " PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
