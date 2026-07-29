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

console.log("\n=== escaping click-through ===");
// The trap: once the window ignores the mouse, the button that turns it off
// is ignored too. Every route out must avoid clicking the window.
ok("global hotkey registered", /globalShortcut\.register\(TOGGLE_HOTKEY/.test(main));
ok("hotkey toggles rather than only enabling",
   /globalShortcut\.register\(TOGGLE_HOTKEY, \(\) => setClickThrough\(!clickThrough\)\)/.test(main));
ok("hotkey released on quit", /globalShortcut\.unregisterAll\(\)/.test(main));
ok("failure to register is reported", /could not register/.test(main),
   "another app may already own the combo");
ok("tray menu can toggle it", /Click-through {2}\(" \+ TOGGLE_HOTKEY/.test(main));
ok("tray menu rebuilds so its checkbox stays true",
   /function rebuildTrayMenu/.test(main) && /rebuildTrayMenu\(\);/.test(main));
ok("showing the window cancels click-through",
   /win\.on\("show", \(\) => \{ if \(clickThrough\) setClickThrough\(false\)/.test(main),
   "otherwise Show from the tray returns an inert window");
ok("on-screen hint names the hotkey", /id="ctHint"/.test(html) && /ctHintKey/.test(html));
ok("hint is shown only while active", /\$\("ctHint"\)\.className = d\.on \? "show" : ""/.test(html));

console.log("\n=== tray actually works ===");
ok("icon file exists", fs.existsSync(path.join(__dirname, "renderer", "icon.png")),
   "makeTray fails silently without it, removing one escape route");
ok("ico exists for the exe", fs.existsSync(path.join(__dirname, "build-icon.ico")));
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

console.log("\n=== packaging ===");
ok("single portable exe, no installer",
   pkg.build.win.target[0].target === "portable", JSON.stringify(pkg.build.win.target));
ok("icon wired into the build", pkg.build.win.icon === "build-icon.ico");
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
