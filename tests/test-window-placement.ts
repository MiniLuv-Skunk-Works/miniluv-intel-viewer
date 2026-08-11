import type { Settings, WindowPlacement } from "../src/contracts";
import {
  captureWindowPlacement,
  defaultWindowBounds,
  legacyBounds,
  resetWindowBounds,
  restoreWindowBounds,
  type DisplayGeometry,
} from "../src/window-placement";
import { ok } from "./support/assertions";

function reachable(
  bounds: { x: number; y: number; width: number; height: number },
  display: DisplayGeometry,
): boolean {
  const area = display.workArea;
  return (
    bounds.x >= area.x &&
    bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width &&
    bounds.y + bounds.height <= area.y + area.height
  );
}

const primary: DisplayGeometry = {
  id: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
};
const left: DisplayGeometry = {
  id: 2,
  workArea: { x: -1280, y: -100, width: 1280, height: 1024 },
  scaleFactor: 1.25,
};
const right: DisplayGeometry = {
  id: 3,
  workArea: { x: 1920, y: 120, width: 2560, height: 1400 },
  scaleFactor: 1.5,
};

console.log("\n=== defaults and legacy placement ===");
const defaultPrimary = defaultWindowBounds(primary);
ok(
  "default position uses the complete primary work-area origin",
  defaultPrimary.x === 1520 && defaultPrimary.y === 40 && reachable(defaultPrimary, primary),
);
const defaultLeft = defaultWindowBounds(left);
ok(
  "default position supports negative display coordinates",
  defaultLeft.x === -400 && defaultLeft.y === -60 && reachable(defaultLeft, left),
);

const legacySettings: Settings = { x: -1200, y: -80, width: 380, height: 460 };
const restoredLegacy = restoreWindowBounds(
  null,
  legacyBounds(legacySettings),
  [primary, left],
  primary.id,
);
ok(
  "legacy bounds restore on the attached display they intersect",
  reachable(restoredLegacy, left) && restoredLegacy.x === -1200,
);
ok("partial legacy bounds are ignored", legacyBounds({ x: 10, width: 380 }) === null);

console.log("\n=== display-aware restoration ===");
const leftPlacement: WindowPlacement = {
  bounds: { x: -380, y: 464, width: 380, height: 460 },
  displayId: left.id,
  workArea: { ...left.workArea },
  scaleFactor: left.scaleFactor,
};
const changedLeft: DisplayGeometry = {
  id: left.id,
  workArea: { x: -1600, y: 0, width: 1600, height: 900 },
  scaleFactor: 2,
};
const changed = restoreWindowBounds(leftPlacement, null, [primary, changedLeft], primary.id);
ok(
  "same-display restore follows origin, resolution, and DPI changes",
  changed.x === -380 && changed.y === 440 && reachable(changed, changedLeft),
  JSON.stringify(changed),
);
ok(
  "DIP window size is not multiplied by scale factor",
  changed.width === 380 && changed.height === 460,
);

const removed = restoreWindowBounds(leftPlacement, null, [primary], primary.id);
ok(
  "a removed monitor maps the window onto the nearest attached display",
  removed.x === 1540 && reachable(removed, primary),
  JSON.stringify(removed),
);

const oversized = restoreWindowBounds(
  null,
  { x: -500, y: -500, width: 10_000, height: 10_000 },
  [primary],
  primary.id,
);
ok(
  "oversized and off-screen bounds are fully clamped",
  reachable(oversized, primary) && oversized.width === 1920 && oversized.height === 1040,
);

const exactIdWins: WindowPlacement = {
  bounds: { x: 100, y: 100, width: 380, height: 460 },
  displayId: right.id,
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
};
const exact = restoreWindowBounds(exactIdWins, null, [primary, right], primary.id);
ok("an attached saved display ID wins over stale coordinates", reachable(exact, right));

console.log("\n=== capture and Reset position ===");
const captured = captureWindowPlacement(
  { x: -500, y: 0, width: 380, height: 460 },
  [primary, left],
  primary.id,
);
ok(
  "capture records matching display metadata",
  captured.displayId === left.id &&
    captured.scaleFactor === left.scaleFactor &&
    captured.workArea.x === left.workArea.x,
);

const resetLeft = resetWindowBounds(
  { x: -900, y: 0, width: 380, height: 460 },
  [primary, left],
  primary.id,
);
ok(
  "Reset position uses the nearest secondary display and its origin",
  resetLeft.x === -400 && resetLeft.y === -60 && reachable(resetLeft, left),
);
const resetPrimary = resetWindowBounds(
  { x: 500, y: 500, width: 380, height: 460 },
  [primary, left],
  primary.id,
);
ok(
  "Reset position uses primary when it is the matching display",
  resetPrimary.x === 1520 && resetPrimary.y === 40 && reachable(resetPrimary, primary),
);
const resetRight = resetWindowBounds(
  { x: 5000, y: 500, width: 380, height: 460 },
  [primary, right],
  primary.id,
);
ok(
  "Reset position chooses the nearest attached display for off-screen coordinates",
  reachable(resetRight, right),
);
