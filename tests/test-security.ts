// Security boundary checks that complement the behavioral renderer DOM suite.
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const controller = fs.readFileSync(path.join(ROOT, "renderer", "controller.ts"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "main.ts"), "utf8");
const feedConnection = fs.readFileSync(path.join(ROOT, "feed-connection.ts"), "utf8");

let pass = 0, fail = 0;
const ok = (name: string, condition: unknown, detail?: unknown): void => {
  if (condition) { pass += 1; console.log("  PASS  " + name); }
  else { fail += 1; console.log("  FAIL  " + name + (detail ? "  -> " + String(detail) : "")); }
};

console.log("\n=== server data has no HTML or selector sink ===");
ok("renderer never assigns innerHTML", !/innerHTML/.test(controller));
ok("server values are assigned as text", /textContent/.test(controller) && /createTextNode/.test(controller));
ok("rendering replaces nodes without parsing markup", /replaceChildren/.test(controller));
ok("scan IDs stay in an element map", /new Map<string, ScanElements\[\]>/.test(controller));
ok("scan IDs are never interpolated into selectors",
   !/querySelector[^\n]*scan\.id|querySelector[^\n]*scanId|CSS\.escape/.test(controller));

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
// Only the ipcMain.handle bodies are reachable from page script; the settings store and
// the SSE client are main-process code the renderer cannot invoke.
const handlerBodies = [...main.matchAll(/handleIpc\("(\w+)",[\s\S]*?\n\}\);/g)]
  .map(x => x[0]).join("\n");
ok("no process spawning reachable from the renderer",
   !/child_process|spawn\(|execFile|exec\(/.test(handlerBodies));
ok("no arbitrary filesystem write reachable from the renderer",
   !/writeFileSync\(|unlink|rmSync/.test(handlerBodies),
   "the settings store owns a fixed main-process path");
const stateBody = (main.match(/handleIpc\("state"[\s\S]*?\n\}\);/) || [""])[0] ?? "";
ok("state() reports pairing as a boolean, never the token itself",
   /paired: !!credentials\?\.get\(\)/.test(stateBody) && !/token: /.test(stateBody),
   "page script must not be able to read the credential");
ok("credentials use asynchronous OS storage",
   /CredentialStore/.test(main) && /safeStorage/.test(main) && /credential\.bin/.test(main));
ok("settings token is migration-only and removed",
   /credentials\.initialize\(settings\.token\)/.test(main) &&
   /initialized\.removeLegacyToken\) await settingsStore\.saveNow\(\{\}, \["token"\]\)/.test(main) &&
   !/settingsStore\.(?:saveNow|scheduleSave)\(\{[^}]*token:/.test(main));
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
