import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClipboardWatcher } from "../src/clipboard-watcher";
import type { ClipboardCapture } from "../src/contracts";

const VOCABULARY = new Set(["tritanium", "pyerite", "damage", "control", "ii"]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function asyncWatcher(readText: () => Promise<string>, foreground = async () => true) {
  const captures: ClipboardCapture[] = [];
  const watcher = new ClipboardWatcher({
    readText,
    foregroundProbe: { isEveClientForeground: foreground },
    pilotValidator: { validate: async () => null },
    setInterval: () => 1 as unknown as NodeJS.Timeout,
    clearInterval: () => undefined,
    onCapture: (capture) => captures.push(capture),
    onIgnored: () => undefined,
  });
  watcher.setVocabulary(VOCABULARY);
  return { watcher, captures };
}

describe("asynchronous clipboard reads", () => {
  it("waits for the initial baseline and never relays pre-existing clipboard text", async () => {
    const baseline = deferred<string>();
    let text = "Tritanium\t100\nPyerite\t200";
    let reads = 0;
    const { watcher, captures } = asyncWatcher(() =>
      ++reads === 1 ? baseline.promise : Promise.resolve(text),
    );
    watcher.start();
    const pending = watcher.poll();
    assert.equal(reads, 1);
    baseline.resolve(text);
    await pending;
    assert.deepEqual(captures, []);
    text = "Tritanium\t300\nPyerite\t400";
    await watcher.poll();
    assert.deepEqual(captures, [{ kind: "cargo", text }]);
    watcher.stop();
  });

  it("seeds from the first successful read if the initial baseline rejects", async () => {
    let reads = 0;
    let text = "Tritanium\t100\nPyerite\t200";
    const { watcher, captures } = asyncWatcher(async () => {
      if (++reads === 1) throw new Error("clipboard busy");
      return text;
    });
    watcher.start();
    await watcher.poll();
    assert.deepEqual(captures, []);
    text = "Tritanium\t300\nPyerite\t400";
    await watcher.poll();
    assert.deepEqual(captures, [{ kind: "cargo", text }]);
    watcher.stop();
  });

  it("discards a read that completes after watching stops", async () => {
    const read = deferred<string>();
    const { watcher, captures } = asyncWatcher(() => read.promise);
    const pending = watcher.poll();
    watcher.stop();
    read.resolve("Tritanium\t100\nPyerite\t200");
    await pending;
    assert.deepEqual(captures, []);
  });

  it("does not let an old baseline overwrite a restarted watcher's baseline", async () => {
    const oldBaseline = deferred<string>();
    const newBaseline = deferred<string>();
    const text = "Tritanium\t100\nPyerite\t200";
    let reads = 0;
    const { watcher, captures } = asyncWatcher(() => {
      reads += 1;
      return reads === 1
        ? oldBaseline.promise
        : reads === 2
          ? newBaseline.promise
          : Promise.resolve(text);
    });
    watcher.start();
    watcher.stop();
    watcher.start();
    newBaseline.resolve(text);
    await watcher.poll();
    oldBaseline.resolve("old clipboard");
    await watcher.poll();
    assert.deepEqual(captures, []);
    watcher.stop();
  });

  it("discards out-of-order reads without replacing the newest observed value", async () => {
    const oldRead = deferred<string>();
    const newRead = deferred<string>();
    const text = "Tritanium\t300\nPyerite\t400";
    let reads = 0;
    const { watcher, captures } = asyncWatcher(() => {
      reads += 1;
      return reads === 1 ? oldRead.promise : reads === 2 ? newRead.promise : Promise.resolve(text);
    });
    const oldPoll = watcher.poll();
    const newPoll = watcher.poll();
    newRead.resolve(text);
    await newPoll;
    oldRead.resolve("Tritanium\t100\nPyerite\t200");
    await oldPoll;
    await watcher.poll();
    assert.deepEqual(captures, [{ kind: "cargo", text }]);
  });

  for (const initiallyForeground of [true, false]) {
    it(`rejects a read when EVE focus changes from ${initiallyForeground}`, async () => {
      let foreground = initiallyForeground;
      const read = deferred<string>();
      const { watcher, captures } = asyncWatcher(
        () => read.promise,
        async () => foreground,
      );
      const pending = watcher.poll();
      foreground = !foreground;
      read.resolve("Tritanium\t100\nPyerite\t200");
      await pending;
      foreground = true;
      await watcher.poll();
      assert.deepEqual(captures, []);
      assert.equal(watcher.stats().ignored, 1);
    });
  }

  it("contains rejected clipboard reads", async () => {
    const { watcher, captures } = asyncWatcher(async () => {
      throw new Error("clipboard unavailable");
    });
    await assert.doesNotReject(watcher.poll());
    assert.deepEqual(captures, []);
  });
});

describe("ClipboardWatcher", () => {
  it("binds one foreground result to each new value and never reconsiders a rejection", async () => {
    let clipboard = "already copied";
    let eveForeground = false;
    let timer: (() => void) | null = null;
    let validationCalls = 0;
    const captures: ClipboardCapture[] = [];
    const ignored: boolean[] = [];
    const watcher = new ClipboardWatcher({
      readText: () => clipboard,
      foregroundProbe: { isEveClientForeground: async () => eveForeground },
      pilotValidator: {
        validate: async () => {
          validationCalls += 1;
          return null;
        },
      },
      setInterval: (callback) => {
        timer = callback;
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {
        timer = null;
      },
      onCapture: (capture) => captures.push(capture),
      onIgnored: (needsVocabulary) => ignored.push(needsVocabulary),
      now: () => 123,
    });

    watcher.setVocabulary(VOCABULARY);
    watcher.setPilotDetection(true);
    watcher.start();
    assert.ok(timer);
    await watcher.poll();

    clipboard = "Fixture Pilot";
    await watcher.poll();
    assert.deepEqual(ignored, [false]);
    assert.equal(validationCalls, 0);

    eveForeground = true;
    await watcher.poll();
    assert.equal(validationCalls, 0, "focus alone must not reconsider an old clipboard value");

    clipboard = "Tritanium\t100\nPyerite\t200";
    await watcher.poll();
    assert.deepEqual(captures, [{ kind: "cargo", text: clipboard }]);
    assert.equal(validationCalls, 0, "fit and cargo never call ESI");

    watcher.markSent("cargo");
    assert.deepEqual(watcher.stats(), {
      sent: 1,
      ignored: 1,
      lastKind: "cargo",
      lastAt: 123,
    });
    watcher.stop();
    assert.equal(timer, null);
  });

  it("fails closed for unknown foreground state before classification or validation", async () => {
    let clipboard = "";
    let validationCalls = 0;
    const captures: ClipboardCapture[] = [];
    const watcher = new ClipboardWatcher({
      readText: () => clipboard,
      foregroundProbe: {
        isEveClientForeground: async () => {
          throw new Error("process lookup denied");
        },
      },
      pilotValidator: {
        validate: async () => {
          validationCalls += 1;
          return "Fixture Pilot";
        },
      },
      onCapture: (capture) => captures.push(capture),
      onIgnored: () => undefined,
    });
    watcher.setVocabulary(VOCABULARY);
    watcher.setPilotDetection(true);
    clipboard = "High Power\nDamage Control II";
    await watcher.poll();
    clipboard = "Fixture Pilot";
    await watcher.poll();
    assert.deepEqual(captures, []);
    assert.equal(validationCalls, 0);
    assert.equal(watcher.stats().ignored, 2);
  });

  it("requires pilot opt-in and syntax, emits only canonical validation, and suppresses stale results", async () => {
    let clipboard = "";
    let validationCalls = 0;
    let resolveOld: (value: string | null) => void = () => undefined;
    const captures: ClipboardCapture[] = [];
    const watcher = new ClipboardWatcher({
      readText: () => clipboard,
      foregroundProbe: { isEveClientForeground: async () => true },
      pilotValidator: {
        validate: async (candidate) => {
          validationCalls += 1;
          if (candidate === "Old Pilot") {
            return new Promise((resolve) => {
              resolveOld = resolve;
            });
          }
          return candidate === "new pilot" ? "New Pilot" : null;
        },
      },
      onCapture: (capture) => captures.push(capture),
      onIgnored: () => undefined,
    });
    watcher.setVocabulary(VOCABULARY);

    clipboard = "Fixture Pilot";
    await watcher.poll();
    assert.equal(validationCalls, 0);

    watcher.setPilotDetection(true);
    clipboard = "not.valid";
    await watcher.poll();
    assert.equal(validationCalls, 0);

    clipboard = "Old Pilot";
    const oldPoll = watcher.poll();
    await Promise.resolve();
    clipboard = "new pilot";
    await watcher.poll();
    assert.deepEqual(captures, [{ kind: "pilot", text: "New Pilot" }]);
    resolveOld("Old Pilot");
    await oldPoll;
    assert.deepEqual(captures, [{ kind: "pilot", text: "New Pilot" }]);
  });

  it("contains clipboard read failures", async () => {
    const watcher = new ClipboardWatcher({
      readText: () => {
        throw new Error("clipboard unavailable");
      },
      foregroundProbe: { isEveClientForeground: async () => true },
      pilotValidator: { validate: async () => null },
      onCapture: () => assert.fail("must not capture"),
      onIgnored: () => assert.fail("must not classify"),
    });
    await assert.doesNotReject(watcher.poll());
  });
});
