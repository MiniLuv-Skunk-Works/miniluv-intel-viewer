import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClipboardWatcher } from "../src/clipboard-watcher";
import type { ClipboardCapture } from "../src/contracts";

const VOCABULARY = new Set(["tritanium", "pyerite", "damage", "control", "ii"]);

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
