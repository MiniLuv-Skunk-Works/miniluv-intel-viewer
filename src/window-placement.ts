import type { Settings, StoredRectangle, WindowPlacement } from "./contracts";

export interface DisplayGeometry {
  id: number;
  workArea: StoredRectangle;
  scaleFactor: number;
}

const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 460;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 200;
const DEFAULT_RIGHT_GAP = 20;
const DEFAULT_TOP_GAP = 40;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function intersectionArea(left: StoredRectangle, right: StoredRectangle): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return width * height;
}

function distanceToRectangleSquared(x: number, y: number, rectangle: StoredRectangle): number {
  const dx =
    x < rectangle.x
      ? rectangle.x - x
      : x > rectangle.x + rectangle.width
        ? x - (rectangle.x + rectangle.width)
        : 0;
  const dy =
    y < rectangle.y
      ? rectangle.y - y
      : y > rectangle.y + rectangle.height
        ? y - (rectangle.y + rectangle.height)
        : 0;
  return dx * dx + dy * dy;
}

function primaryDisplay(displays: readonly DisplayGeometry[], primaryId: number): DisplayGeometry {
  const primary = displays.find((display) => display.id === primaryId) ?? displays[0];
  if (!primary) throw new Error("At least one attached display is required.");
  return primary;
}

function nearestDisplay(
  bounds: StoredRectangle,
  displays: readonly DisplayGeometry[],
  primaryId: number,
): DisplayGeometry {
  const fallback = primaryDisplay(displays, primaryId);
  let best = fallback;
  let bestIntersection = intersectionArea(bounds, fallback.workArea);
  for (const display of displays) {
    const intersection = intersectionArea(bounds, display.workArea);
    if (intersection > bestIntersection) {
      best = display;
      bestIntersection = intersection;
    }
  }
  if (bestIntersection > 0) return best;

  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  let bestDistance = distanceToRectangleSquared(centerX, centerY, fallback.workArea);
  best = fallback;
  for (const display of displays) {
    const distance = distanceToRectangleSquared(centerX, centerY, display.workArea);
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }
  return best;
}

function fitToWorkArea(bounds: StoredRectangle, workArea: StoredRectangle): StoredRectangle {
  const minimumWidth = Math.min(MIN_WIDTH, workArea.width);
  const minimumHeight = Math.min(MIN_HEIGHT, workArea.height);
  const width = clamp(Math.round(bounds.width), minimumWidth, workArea.width);
  const height = clamp(Math.round(bounds.height), minimumHeight, workArea.height);
  return {
    x: clamp(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - width),
    y: clamp(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function relativeCoordinate(
  coordinate: number,
  size: number,
  oldOrigin: number,
  oldSize: number,
  newOrigin: number,
  newSize: number,
): number {
  const oldTravel = Math.max(0, oldSize - size);
  const newTravel = Math.max(0, newSize - size);
  if (oldTravel === 0) return newOrigin;
  const ratio = clamp((coordinate - oldOrigin) / oldTravel, 0, 1);
  return newOrigin + ratio * newTravel;
}

export function legacyBounds(settings: Settings): StoredRectangle | null {
  if (
    settings.x === undefined ||
    settings.y === undefined ||
    settings.width === undefined ||
    settings.height === undefined
  )
    return null;
  return { x: settings.x, y: settings.y, width: settings.width, height: settings.height };
}

export function defaultWindowBounds(display: DisplayGeometry): StoredRectangle {
  const width = Math.min(DEFAULT_WIDTH, display.workArea.width);
  const height = Math.min(DEFAULT_HEIGHT, display.workArea.height);
  return fitToWorkArea(
    {
      x: display.workArea.x + display.workArea.width - width - DEFAULT_RIGHT_GAP,
      y: display.workArea.y + DEFAULT_TOP_GAP,
      width,
      height,
    },
    display.workArea,
  );
}

export function restoreWindowBounds(
  placement: WindowPlacement | null,
  legacy: StoredRectangle | null,
  displays: readonly DisplayGeometry[],
  primaryId: number,
): StoredRectangle {
  if (!placement && !legacy) return defaultWindowBounds(primaryDisplay(displays, primaryId));

  const savedBounds = placement?.bounds ?? legacy!;
  const exactDisplay = placement
    ? displays.find((display) => display.id === placement.displayId)
    : undefined;
  const target = exactDisplay ?? nearestDisplay(savedBounds, displays, primaryId);
  if (!placement) return fitToWorkArea(savedBounds, target.workArea);

  const mapped = {
    x: relativeCoordinate(
      placement.bounds.x,
      placement.bounds.width,
      placement.workArea.x,
      placement.workArea.width,
      target.workArea.x,
      target.workArea.width,
    ),
    y: relativeCoordinate(
      placement.bounds.y,
      placement.bounds.height,
      placement.workArea.y,
      placement.workArea.height,
      target.workArea.y,
      target.workArea.height,
    ),
    width: placement.bounds.width,
    height: placement.bounds.height,
  };
  return fitToWorkArea(mapped, target.workArea);
}

export function captureWindowPlacement(
  bounds: StoredRectangle,
  displays: readonly DisplayGeometry[],
  primaryId: number,
): WindowPlacement {
  const display = nearestDisplay(bounds, displays, primaryId);
  return {
    bounds: fitToWorkArea(bounds, display.workArea),
    displayId: display.id,
    workArea: { ...display.workArea },
    scaleFactor: display.scaleFactor,
  };
}

export function resetWindowBounds(
  currentBounds: StoredRectangle,
  displays: readonly DisplayGeometry[],
  primaryId: number,
): StoredRectangle {
  return defaultWindowBounds(nearestDisplay(currentBounds, displays, primaryId));
}
