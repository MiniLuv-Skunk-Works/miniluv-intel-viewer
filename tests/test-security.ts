import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(__dirname, "..", "..");
const source = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");

describe("renderer containment policy", () => {
  it("uses text-only rendering and a deny-by-default CSP", () => {
    const renderer = source("src/renderer/controller.ts");
    const html = source("src/renderer/index.html");
    assert.doesNotMatch(renderer, /innerHTML|outerHTML|insertAdjacentHTML/);
    assert.match(renderer, /textContent/);
    assert.match(renderer, /replaceChildren/);
    assert.match(html, /default-src 'none'/);
    assert.match(html, /connect-src 'none'/);
    assert.doesNotMatch(html, /<script>(?:.|\n)*\S(?:.|\n)*<\/script>/);
  });

  it("keeps hardened BrowserWindow preferences and native escape blocking", () => {
    const windows = source("src/window-manager.ts");
    assert.match(windows, /contextIsolation: true/);
    assert.match(windows, /nodeIntegration: false/);
    assert.match(windows, /sandbox: true/);
    assert.match(windows, /webviewTag: false/);
    assert.match(windows, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
    assert.match(windows, /will-navigate/);
    assert.match(windows, /will-attach-webview/);
  });
});

describe("main-process authority", () => {
  it("authorizes every IPC call against the current viewer main frame", () => {
    const handlers = source("src/ipc-handlers.ts");
    assert.match(handlers, /runAuthorizedIpc/);
    assert.match(handlers, /getWebContents/);
    for (const channel of [
      "pair",
      "unpair",
      "state",
      "opacity",
      "bump",
      "clipwatch",
      "preferences",
      "savePreferences",
      "scenarioCalculation",
      "diagnostics",
      "checkUpdate",
      "openUpdate",
      "close",
    ]) {
      assert.match(handlers, new RegExp(`handle\\(\\s*"${channel}"`));
    }
  });

  it("never exposes credentials through the preload API", () => {
    const preload = source("src/preload.ts");
    assert.doesNotMatch(preload, /safeStorage|credential\.bin|token:/);
    assert.match(preload, /contextBridge\.exposeInMainWorld\("milf", api\)/);
  });
});
