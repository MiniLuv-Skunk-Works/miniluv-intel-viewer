import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PilotNameValidator,
  type PilotNameClock,
  type PilotNameHttpClient,
  type PilotNameHttpResponse,
} from "../src/pilot-name-validator";

class FakeClock implements PilotNameClock {
  value = 1_000;
  readonly sleeps: number[] = [];
  now(): number {
    return this.value;
  }
  async sleep(delayMs: number): Promise<void> {
    this.sleeps.push(delayMs);
    this.value += delayMs;
  }
}

const match = (name: string, headers: Record<string, string> = {}): PilotNameHttpResponse => ({
  status: 200,
  headers,
  body: { characters: [{ id: 123, name }] },
});

describe("PilotNameValidator", () => {
  it("returns only an exact canonical character match", async () => {
    const responses: Array<PilotNameHttpResponse | null> = [
      match("Fixture Pilot"),
      match("Fixture Pilot Extra"),
      { status: 200, headers: {}, body: { corporations: [{ name: "Fixture Pilot" }] } },
      { status: 429, headers: {}, body: { characters: [{ name: "Fixture Pilot" }] } },
      null,
      { status: 200, headers: {}, body: "malformed" },
    ];
    const http: PilotNameHttpClient = { lookup: async () => responses.shift() ?? null };
    const validator = new PilotNameValidator(http, new FakeClock());
    assert.equal(await validator.validate("fixture pilot"), "Fixture Pilot");
    assert.equal(await validator.validate("Partial Pilot"), null);
    assert.equal(await validator.validate("Corporation Name"), null);
    assert.equal(await validator.validate("Rate Limited"), null);
    assert.equal(await validator.validate("Timed Out"), null);
    assert.equal(await validator.validate("Malformed Body"), null);
  });

  it("uses bounded positive and negative TTL caches and evicts the oldest entry", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const http: PilotNameHttpClient = {
      lookup: async (candidate) => {
        calls += 1;
        return candidate.startsWith("Missing")
          ? { status: 200, headers: {}, body: { characters: [] } }
          : match(candidate);
      },
    };
    const validator = new PilotNameValidator(http, clock);
    assert.equal(await validator.validate("Cache Pilot"), "Cache Pilot");
    assert.equal(await validator.validate("cache pilot"), "Cache Pilot");
    assert.equal(calls, 1);
    clock.value += 24 * 60 * 60 * 1_000 + 1;
    await validator.validate("Cache Pilot");
    assert.equal(calls, 2);

    assert.equal(await validator.validate("Missing Pilot"), null);
    assert.equal(await validator.validate("missing pilot"), null);
    assert.equal(calls, 3);
    clock.value += 10 * 60 * 1_000 + 1;
    await validator.validate("Missing Pilot");
    assert.equal(calls, 4);

    for (let index = 0; index < 513; index += 1) {
      await validator.validate(`Pilot ${String(index).padStart(3, "0")}`);
    }
    const beforeOldestRetry = calls;
    await validator.validate("Pilot 000");
    assert.equal(calls, Number(beforeOldestRetry) + 1);
  });

  it("serializes requests, starts at most once per second, and respects ESI error budget", async () => {
    const clock = new FakeClock();
    const starts: number[] = [];
    let resolveFirst: (response: PilotNameHttpResponse) => void = () => undefined;
    const http: PilotNameHttpClient = {
      lookup: async (candidate) => {
        starts.push(clock.now());
        if (candidate === "First Pilot") {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return match(candidate, {
          "x-esi-error-limit-remain": candidate === "Second Pilot" ? "0" : "100",
          "x-esi-error-limit-reset": "10",
        });
      },
    };
    const validator = new PilotNameValidator(http, clock);
    const first = validator.validate("First Pilot");
    await Promise.resolve();
    const second = validator.validate("Second Pilot");
    await Promise.resolve();
    assert.equal(starts.length, 1);
    resolveFirst(match("First Pilot"));
    await first;
    await second;
    assert.equal(starts.length, 2);
    assert.ok(starts[1]! - starts[0]! >= 1_000);

    assert.equal(await validator.validate("Budget Pilot"), null);
    assert.equal(starts.length, 2);
    clock.value += 10_000;
    assert.equal(await validator.validate("Budget Pilot"), "Budget Pilot");
    assert.equal(starts.length, 3);
  });
});
