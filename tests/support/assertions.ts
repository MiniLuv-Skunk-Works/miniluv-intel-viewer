import assert from "node:assert/strict";
import { inspect } from "node:util";

export function ok(name: string, condition: unknown, detail?: unknown): void {
  assert.ok(condition, detail === undefined ? name : `${name}: ${inspect(detail)}`);
}
