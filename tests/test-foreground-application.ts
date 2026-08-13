import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WindowsForegroundApplicationProbe,
  createWin32ForegroundBindings,
  type Win32ForegroundBindings,
} from "../src/foreground-application";

function bindings(executablePath: string, overrides: Partial<Win32ForegroundBindings> = {}) {
  let closes = 0;
  const fake: Win32ForegroundBindings = {
    getForegroundWindow: () => ({ window: true }),
    getWindowThreadProcessId: (_window, processId) => {
      processId[0] = 42;
      return 1;
    },
    openProcess: () => ({ process: true }),
    queryFullProcessImageName: (_process, _flags, buffer, size) => {
      const encoded = Buffer.from(executablePath, "utf16le");
      encoded.copy(buffer);
      size[0] = executablePath.length;
      return true;
    },
    closeHandle: () => {
      closes += 1;
      return true;
    },
    ...overrides,
  };
  return { fake, closes: () => closes };
}

describe("WindowsForegroundApplicationProbe", () => {
  it("allows only the resolved EVE client executable and always closes process handles", async () => {
    const eve = bindings("C:\\EVE\\SharedCache\\tq\\bin64\\exefile.exe");
    assert.equal(
      await new WindowsForegroundApplicationProbe(eve.fake).isEveClientForeground(),
      true,
    );
    assert.equal(eve.closes(), 1);

    const launcher = bindings("C:\\Users\\Pilot\\AppData\\Local\\eve-online.exe");
    assert.equal(
      await new WindowsForegroundApplicationProbe(launcher.fake).isEveClientForeground(),
      false,
    );
    assert.equal(launcher.closes(), 1);
  });

  it("fails closed for missing windows, access denial, empty paths, and Win32 errors", async () => {
    const cases: Win32ForegroundBindings[] = [
      bindings("", { getForegroundWindow: () => null }).fake,
      bindings("", { openProcess: () => null }).fake,
      bindings("", { queryFullProcessImageName: () => false }).fake,
      bindings("", {
        getForegroundWindow: () => {
          throw new Error("denied");
        },
      }).fake,
    ];
    for (const fake of cases) {
      assert.equal(
        await new WindowsForegroundApplicationProbe(fake).isEveClientForeground(),
        false,
      );
    }
    assert.equal(await new WindowsForegroundApplicationProbe(null).isEveClientForeground(), false);
  });

  it("loads the local Windows x64 native binding used by the portable build", () => {
    assert.equal(
      createWin32ForegroundBindings() !== null,
      process.platform === "win32" && process.arch === "x64",
    );
  });
});
