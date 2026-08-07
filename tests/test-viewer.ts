import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(__dirname, "..", "..");
const source = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(source("package.json")) as {
  engines?: { node?: string };
  scripts: Record<string, string>;
  build: { files: string[]; win: { target: Array<{ target: string }> } };
};

describe("application structure", () => {
  it("keeps Electron lifecycle wiring in the entry point", () => {
    const main = source("main.ts");
    assert.match(main, /new ViewerController/);
    assert.match(main, /new WindowManager/);
    assert.match(main, /registerIpcHandlers/);
    assert.doesNotMatch(main, /requestJson|new BrowserWindow|ipcMain\.handle/);
  });

  it("keeps the overlay non-injected", () => {
    assert.match(source("main.ts"), /inject into EVE/);
  });

  it("defines the complete local and CI quality gate", () => {
    for (const script of [
      "lint",
      "format",
      "format:check",
      "typecheck",
      "test:unit",
      "test:electron",
      "test:package",
      "verify",
    ]) {
      assert.ok(pkg.scripts[script], `missing npm script ${script}`);
    }
    assert.equal(pkg.engines?.node, ">=22 <23");
  });
});

describe("packaging", () => {
  it("packages compiled production code and renderer assets only", () => {
    assert.ok(pkg.build.files.includes(".build/**/*"));
    assert.ok(pkg.build.files.includes("!.build/tests/**/*"));
    assert.ok(pkg.build.files.includes("renderer/index.html"));
    assert.equal(pkg.build.win.target[0]?.target, "portable");
  });
});
