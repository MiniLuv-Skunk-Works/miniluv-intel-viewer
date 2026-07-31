// Electron can't run headless here, so these are structural checks on the
// things that would strand a user: no way out of click-through, a dead
// channel, a missing icon.
const fs = require("fs");
const path = require("path");

const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const pre = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "renderer", "index.html"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (n, c, d) => c ? (pass++, console.log("  PASS  " + n))
                          : (fail++, console.log("  FAIL  " + n + (d ? "  -> " + d : "")));

console.log("\n=== click-through is gone ===");
[main, pre, html].forEach(function (f, i) {
  ok(["main.js", "preload.js", "renderer"][i] + " has no trace of it",
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
ok("cycles on click", /applyOpacity\(\(opLevel \+ 1\) % 3\)/.test(html));
ok("preference is persisted", /ipcMain\.handle\("opacity"/.test(main) && /save\(\{ opacity/.test(main));
ok("restored on launch", /applyOpacity\(st\.opacity/.test(html));
ok("background only, not the whole window",
   !/win\.setOpacity\(/.test(main.replace(/\/\/.*/g, "")),
   "win.setOpacity would fade the text along with it");
ok("detail panel follows the same alpha", /#detail \{[^}]*background: var\(--bg\)/.test(html));

console.log("\n=== tray actually works ===");
ok("icon file exists", fs.existsSync(path.join(__dirname, "renderer", "icon.png")),
   "makeTray fails silently without it, removing one escape route");
ok("ico exists for the exe", fs.existsSync(path.join(__dirname, "build", "icon.ico")));
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

console.log("\n=== ipc surface is complete ===");
const invokes = new Set([...pre.matchAll(/ipcRenderer\.invoke\("(\w+)"/g)].map(m => m[1]));
const handled = new Set([...main.matchAll(/ipcMain\.handle\("(\w+)"/g)].map(m => m[1]));
const relayed = new Set([...main.matchAll(/relay\("(\w+)"/g)].map(m => m[1]));
const listened = new Set([...pre.matchAll(/ipcRenderer\.on\("(\w+)"/g)].map(m => m[1]));
ok("every invoke has a handler", [...invokes].every(i => handled.has(i)),
   [...invokes].filter(i => !handled.has(i)).join(","));
ok("every relay has a listener", [...relayed].every(r => listened.has(r)),
   [...relayed].filter(r => !listened.has(r)).join(","));

console.log("\n=== icons ===");
const fsx = require("fs");
ok("build/icon.ico exists where electron-builder looks",
   fsx.existsSync(path.join(__dirname, "build", "icon.ico")),
   "it silently falls back to the Electron default rather than erroring");
ok("ico contains a 256px frame", (function () {
  // electron-builder rejects ICOs without one, and Windows needs it for large views.
  const buf = fsx.readFileSync(path.join(__dirname, "build", "icon.ico"));
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
   /icon: path\.join\(__dirname, "renderer", "icon-256\.png"\)/.test(main),
   "win.icon in the build config does nothing for the running window");
ok("window icon is inside build.files",
   pkg.build.files.some(f => f.startsWith("renderer")),
   "build/ is buildResources - not present in the packaged app");

console.log("\n=== packaging ===");
ok("single portable exe, no installer",
   pkg.build.win.target[0].target === "portable", JSON.stringify(pkg.build.win.target));
ok("icon wired into the build", pkg.build.win.icon === "build/icon.ico");
ok("build script present", !!pkg.scripts.build);
ok("renderer assets included", pkg.build.files.includes("renderer/**/*"));

console.log("\n=== security posture unchanged ===");
ok("contextIsolation on", /contextIsolation: true/.test(main));
ok("nodeIntegration off", /nodeIntegration: false/.test(main));
ok("renderer has a CSP", /Content-Security-Policy/.test(html));
ok("scan text is escaped before rendering", /function esc\b/.test(html));
ok("not an injected overlay", /NOT an injected overlay/.test(main),
   "the EULA reasoning should stay documented in the source");

console.log("\n" + (fail === 0 ? "ALL " + pass + " PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
