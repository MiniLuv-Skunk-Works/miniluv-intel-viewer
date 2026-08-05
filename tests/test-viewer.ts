// Electron can't run headless here, so these are structural checks on the
// things that would strand a user: no way out of click-through, a dead
// channel, a missing icon.
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const main = fs.readFileSync(path.join(ROOT, "main.ts"), "utf8");
const pre = fs.readFileSync(path.join(ROOT, "preload.ts"), "utf8");
// The renderer script now lives in app.js, extracted so the CSP can forbid
// inline script. Checks that look for behaviour need both files.
const markup = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
const rendererJs = fs.readFileSync(path.join(ROOT, "renderer", "app.ts"), "utf8");
const html = markup + "\n" + rendererJs;
interface PackageConfig {
  main: string;
  scripts: Record<string, string>;
  build: {
    files: string[];
    directories: { buildResources: string };
    win: { icon: string; target: Array<{ target: string }> };
  };
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as PackageConfig;

let pass = 0, fail = 0;
const ok = (name: string, condition: unknown, detail?: unknown): void => {
  if (condition) { pass += 1; console.log("  PASS  " + name); }
  else { fail += 1; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail) : "")); }
};

console.log("\n=== click-through is gone ===");
[main, pre, html].forEach(function (f, i) {
  ok((["main.ts", "preload.ts", "renderer"][i] ?? "source") + " has no trace of it",
     !/clickThrough|setIgnoreMouseEvents|globalShortcut|TOGGLE_HOTKEY/i.test(f));
});

console.log("\n=== transparency ===");
ok("three levels defined", /body\.op0/.test(html) && /body\.op1/.test(html) && /body\.op2/.test(html));
ok("default is not fully opaque", (function () {
  const m = /body\.op1 \{ --bg: rgba\(16,17,19,\.(\d+)\)/.exec(html);
  return m && Number(m[1]) < 90;
})(), "asserting one exact alpha breaks on any tuning");
ok("levels are visibly different", (function () {
  const a = [...html.matchAll(/body\.op\d \{ --bg: rgba\(16,17,19,\.(\d+)\)/g)].map(x => Number(x[1]));
  return a.length === 3 && Math.max(...a) - Math.min(...a) >= 30;
})(), "0.78/0.80/0.62 was imperceptible");
ok("cycles on click", /applyOpacity\(\(\(opLevel \+ 1\) % 3\) as OpacityLevel\)/.test(html));
ok("preference is persisted", /handleIpc\("opacity"/.test(main) && /save\(\{ opacity/.test(main));
ok("restored on launch", /applyOpacity\(st\.opacity/.test(html));
ok("background only, not the whole window",
   !/win\.setOpacity\(/.test(main.replace(/\/\/.*/g, "")),
   "win.setOpacity would fade the text along with it");
ok("detail panel follows the same alpha", /#detail \{[^}]*background: var\(--bg\)/.test(html));

console.log("\n=== tray actually works ===");
ok("icon file exists", fs.existsSync(path.join(ROOT, "renderer", "icon.png")),
   "makeTray fails silently without it, removing one escape route");
ok("ico exists for the exe", fs.existsSync(path.join(ROOT, "build", "icon.ico")));
ok("tray failure is logged, not swallowed", /tray icon missing:/.test(main));

console.log("\n=== detail popup ===");
ok("entries are clickable", /class="scan"[^>]*data-id=/.test(html) || /data-id="' \+ esc\(s\.id\)/.test(html));
ok("opens a detail view", /function openDetail/.test(html));
ok("shows the fit", /fitEft/.test(html));
ok("shows cargo", /cargoList/.test(html));
ok("says so when they're absent", /Not included in this scan/.test(html));
ok("has a way back", /id="detailClose"/.test(html));

console.log("\n=== clear ===");
ok("button present", /id="clearBtn"/.test(html));
ok("also on the tray menu", /label: "Clear feed"/.test(main));
ok("clearing closes an open detail view",
   /scans = \[\];\s*\n\s*\$\("detail"\)\.className = "";/.test(html),
   "otherwise the popup shows a scan that's no longer in the list");

console.log("\n=== bump timers ===");
ok("BUMP button on each entry", /data-bump="/.test(html));
ok("button click doesn't open the detail popup",
   /e\.target\.hasAttribute\("data-bump"\)\s*\)\s*return/.test(html),
   "the button sits inside the row, which is itself clickable");
ok("countdown row per scan", /data-bumprow="/.test(html));
ok("counts DOWN, not up", /var left = b\.remainingMs - elapsed/.test(html) &&
   /left <= 0 \? "OUT"/.test(html),
   "an FC wants how long is left, not how long it has been");
ok("goes amber then red", /" warn"/.test(html) && /" gone"/.test(html));
ok("amber is a fixed 30s, not a fraction of the hold", /left <= 30000/.test(html),
   "a percentage would go amber a full minute early on a 180s bump");
ok("reads as m:ss above a minute", /padStart\(2, "0"\)/.test(html),
   "\"2:45\" is easier to call than \"165s\"");
ok("shows OUT when the hold lapses", /"OUT"/.test(html));
ok("names the bumper and the re-bump count", /b\.by \+/.test(html) && /b\.count > 1/.test(html));
ok("timers survive a re-render", /paintBumps\(\);\s*\/\/ a re-render/.test(html),
   "the scan list redraws on every new scan");
ok("bump sent with the viewer token", /"Authorization": "Bearer " \+ token/.test(main));
ok("timer comes from the feed, not the POST response",
   /The timer itself arrives over the feed/.test(main),
   "the bumper must see the same clock as everyone else");
ok("cleared bumps hide the row", /onBumpCleared/.test(html) && /bumpCleared/.test(main));

console.log("\n=== clipboard watching ===");
ok("off by default", !/watchClipboard: true/.test(main) && /load\(\)\.watchClipboard/.test(main),
   "reading someone's clipboard is not a thing to switch on for them");
ok("filtered before anything is sent", /classify\(text, vocabulary\)/.test(main) && /if \(!clip\)/.test(main),
   "rejects must never reach the network");
ok("seeded on enable, so old clipboard content is not fired off",
   /lastClip = clipboard\.readText\(\)/.test(main));
ok("button shows when armed", /armed/.test(html));
ok("stopped on quit", /stopClipWatch\(\)/.test(main));
ok("vocabulary fetched and cached", /fetchVocabulary/.test(main) && /vocabulary\.json/.test(main));
ok("re-fetched on a new pairing", /vocabulary = null;[\s\S]{0,40}fetchVocabulary/.test(main),
   "a different dashboard may run a different SDE build");
ok("says when no dashboard tab is open", /no dashboard tab open/.test(html),
   "otherwise a successful capture looks like nothing happened");
ok("stops an armed watcher when the dashboard lacks clipboard capabilities",
   /if \(clipboardSupported\)[\s\S]{0,160}else \{\s*stopClipWatch\(\)/.test(main));

console.log("\n=== protocol negotiation ===");
ok("hello is negotiated before compatibility status is relayed",
   /protocol = negotiateProtocol\(hello\)/.test(main) && /protocolStatus\(hello\.name, protocol\)/.test(main));
ok("bump writes require the advertised capability",
   /supports\(PROTOCOL_CAPABILITIES\.bumpControl\)/.test(main));
ok("clipboard requests require both advertised capabilities",
   /supports\(PROTOCOL_CAPABILITIES\.clipboardRelay\)/.test(main) &&
   /supports\(PROTOCOL_CAPABILITIES\.clipboardVocabulary\)/.test(main));
ok("future dashboards retain scan feed with a compact warning",
   /newer - scan feed only/.test(main));
ok("compatibility warnings survive transient messages",
   /protocolNotice/.test(html) && /s = protocolNotice/.test(html));

console.log("\n=== bump timers survive clock skew ===");
// The bug: left = holdMs - (Date.now() - serverAt) subtracts the viewer's
// clock from the server's. A viewer 40s fast opened a fresh 3:00 at 2:20.
ok("no server timestamp in the countdown", !/now - b\.at/.test(html),
   "cross-machine subtraction is the whole fault");
ok("anchored to a monotonic local clock",
   /receivedAt: performance\.now\(\)/.test(html) &&
   /now = performance\.now\(\)/.test(html) &&
   /now - b\.receivedAt/.test(html));
ok("counts down from server-supplied remaining", /b\.remainingMs - elapsed/.test(html));
ok("replayed hold has a part-full bar", /left \/ b\.totalMs/.test(html) &&
   /Number\(b\.holdMs\)/.test(html),
   "the full hold is the bar denominator, not the remaining duration");
ok("validates server-reported remaining time",
   /remainingMs = Number\(b\.remainingMs\)/.test(html) &&
   /Number\.isFinite\(remainingMs\)/.test(html));
ok("tolerates an older server without using its clock",
   /remainingMs = Number\(b\.holdMs\)/.test(html));

console.log("\n=== entry layout ===");
// Once a gank is called the FC knows the system; what they need on the title
// line is the name they are looking for on grid.
ok("pilot on the title line, in parens", /class="pilot">\(/.test(html));
ok("pilot omitted cleanly when unknown", /s\.pilot \?/.test(html),
   "empty parens would be worse than nothing");
ok("system moved to the meta line", /scanned in " \+ esc\(s\.system\)/.test(html));
ok("system no longer on the title line", !/class="sys">' \+ esc\(s\.system/.test(html));
ok("pilot truncates instead of shoving the controls off",
   /\.pilot \{[^}]*text-overflow: ellipsis/.test(html),
   "the window can be dragged to 280px and BUMP must stay reachable");

console.log("\n=== bump failures are diagnosable ===");
// "Not Found" told the user nothing and pointed at the wrong component.
ok("a missing route is named as an out-of-date dashboard",
   /doesn't support bumping yet/.test(main));
ok("distinguished from a scan that aged out",
   /!failure\.detail &&/.test(main) && /not found\/i\.test/.test(main),
   "both are 404s with completely different fixes");
ok("the button shows it is working", /btn\.disabled = true/.test(html));
ok("errors stay on screen long enough to read", /12000/.test(html));

console.log("\n=== ipc surface is complete ===");
const invokes = new Set([...pre.matchAll(/invokeUnknown\("(\w+)"/g)].map(m => m[1]));
const handled = new Set([...main.matchAll(/handleIpc\("(\w+)"/g)].map(m => m[1]));
const relayed = new Set([...main.matchAll(/relay\("(\w+)"/g)].map(m => m[1]));
const listened = new Set([...pre.matchAll(/onIpc\("(\w+)"/g)].map(m => m[1]));
ok("every invoke has a handler", [...invokes].every(i => handled.has(i)),
   [...invokes].filter(i => !handled.has(i)).join(","));
ok("every relay has a listener", [...relayed].every(r => listened.has(r)),
   [...relayed].filter(r => !listened.has(r)).join(","));

console.log("\n=== icons ===");
const fsx = require("fs");
ok("build/icon.ico exists where electron-builder looks",
   fsx.existsSync(path.join(ROOT, "build", "icon.ico")),
   "it silently falls back to the Electron default rather than erroring");
ok("ico contains a 256px frame", (function () {
  // electron-builder rejects ICOs without one, and Windows needs it for large views.
  const buf = fsx.readFileSync(path.join(ROOT, "build", "icon.ico"));
  const count = buf.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const w = buf[6 + i * 16];
    if (w === 0) return true;   // 0 encodes 256 in the ICO header
  }
  return false;
})());
ok("build config points at it", pkg.build.win.icon === "build/icon.ico", pkg.build.win.icon);
ok("buildResources declared", pkg.build.directories.buildResources === "build");
ok("window icon set separately from the exe icon",
   /icon: path\.join\(__dirname, "\.\.", "renderer", "icon-256\.png"\)/.test(main),
   "win.icon in the build config does nothing for the running window");
ok("window icon is inside build.files",
   pkg.build.files.some(f => f.startsWith("renderer")),
   "build/ is buildResources - not present in the packaged app");

console.log("\n=== packaging ===");
ok("compiled Electron entry is configured", pkg.main === ".build/main.js", pkg.main);
ok("compiled production is packaged", pkg.build.files.includes(".build/**/*"));
ok("compiled tests are excluded", pkg.build.files.includes("!.build/tests/**/*"));
ok("TypeScript source is not packaged", !pkg.build.files.some((pattern) => pattern.endsWith(".ts")));

ok("single portable exe, no installer",
   pkg.build.win.target[0]?.target === "portable", JSON.stringify(pkg.build.win.target));
ok("icon wired into the build", pkg.build.win.icon === "build/icon.ico");
ok("code, test, and typecheck scripts present",
   !!pkg.scripts.build && !!pkg.scripts["build:code"] && !!pkg.scripts["build:tests"] && !!pkg.scripts.typecheck);
ok("renderer assets included",
   pkg.build.files.includes("renderer/index.html") && pkg.build.files.includes("renderer/icon.png"));

console.log("\n=== security posture unchanged ===");
ok("contextIsolation on", /contextIsolation: true/.test(main));
ok("nodeIntegration off", /nodeIntegration: false/.test(main));
ok("renderer has a CSP", /Content-Security-Policy/.test(html));
ok("scan text is escaped before rendering", /function esc\b/.test(html));
ok("not an injected overlay", /NOT an injected overlay/.test(main),
   "the EULA reasoning should stay documented in the source");

console.log("\n" + (fail === 0 ? "ALL " + pass + " PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
