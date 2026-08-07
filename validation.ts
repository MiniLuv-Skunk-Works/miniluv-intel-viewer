export const VALIDATION_LIMITS = Object.freeze({
  url: 2_048,
  pairingCode: 64,
  token: 8_192,
  id: 256,
  label: 512,
  longText: 64_000,
  listEntries: 1_000,
  vocabularyEntries: 100_000,
  vocabularyWord: 256,
  maxTimestamp: 8_640_000_000_000_000,
  maxDurationMs: 86_400_000,
});

export type UnknownRecord = Record<string, unknown>;

export function plainRecord(value: unknown): UnknownRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? (value as UnknownRecord) : null;
  } catch {
    return null;
  }
}

export function hasOnlyKeys(source: UnknownRecord, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(source).every((key) => allowed.has(key));
}

export function boundedString(value: unknown, maximum: number, minimum = 0): string | null {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) return null;
  if (minimum > 0 && value.trim().length === 0) return null;
  return value;
}

export interface NumberBounds {
  minimum?: number;
  maximum?: number;
  integer?: boolean;
}

export function boundedNumber(value: unknown, bounds: NumberBounds = {}): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (bounds.integer && !Number.isSafeInteger(value)) return null;
  if (bounds.minimum !== undefined && value < bounds.minimum) return null;
  if (bounds.maximum !== undefined && value > bounds.maximum) return null;
  return value;
}

export function boundedNumberLike(value: unknown, bounds: NumberBounds = {}): number | null {
  let normalized = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
      return null;
    }
    normalized = Number(trimmed);
  }
  return boundedNumber(normalized, bounds);
}
