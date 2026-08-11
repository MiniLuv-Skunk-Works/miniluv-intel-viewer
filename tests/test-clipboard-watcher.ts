import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClipboardWatcher } from "../src/clipboard-watcher";
import type { ClipboardCapture } from "../src/contracts";

describe("ClipboardWatcher", () => {
  it("seeds existing text, filters locally, and reports later valid captures", () => {
    let clipboard = "already copied";
    let timer: (() => void) | null = null;
    const captures: ClipboardCapture[] = [];
    const ignored: boolean[] = [];
    const watcher = new ClipboardWatcher({
      readText: () => clipboard,
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

    watcher.start();
    assert.ok(timer);
    watcher.poll();
    assert.equal(captures.length, 0);

    clipboard = "not eve data";
    watcher.poll();
    assert.deepEqual(ignored, [true]);

    watcher.setVocabulary(new Set(["tritanium", "pyerite"]));
    clipboard = "Tritanium\t100\nPyerite\t200";
    watcher.poll();
    assert.deepEqual(captures, [{ kind: "cargo", text: "Tritanium\t100\nPyerite\t200" }]);

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

  it("contains clipboard read failures", () => {
    const watcher = new ClipboardWatcher({
      readText: () => {
        throw new Error("clipboard unavailable");
      },
      onCapture: () => assert.fail("must not capture"),
      onIgnored: () => assert.fail("must not classify"),
    });
    assert.doesNotThrow(() => watcher.poll());
  });
});
