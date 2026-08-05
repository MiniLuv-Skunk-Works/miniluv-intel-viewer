import {
  KNOWN_CAPABILITIES,
  PROTOCOL_CAPABILITIES,
  VIEWER_PROTOCOL_MAX_VERSION,
  VIEWER_PROTOCOL_MIN_VERSION,
  negotiateProtocol,
  parseBumpClearedEvent,
  parseBumpEvent,
  parseClaimResponse,
  parseClipboardResult,
  parseConnectionStatus,
  parseHelloEvent,
  parsePairRequest,
  parsePairResult,
  parseScan,
  parseSettings,
  parseViewerState,
  parseVocabulary,
} from "../contracts";
import * as fs from "node:fs";
import * as path from "node:path";

let pass = 0;
let fail = 0;

function ok(name: string, condition: unknown, detail?: unknown): void {
  if (condition) {
    pass += 1;
    console.log("  PASS  " + name);
  } else {
    fail += 1;
    console.log("  FAIL  " + name + (detail ? "  -> " + String(detail) : ""));
  }
}

console.log("\n=== settings boundary ===");
const settings = parseSettings({
  serverUrl: "https://dashboard.example",
  token: "token",
  x: 10,
  y: 20,
  width: 380,
  height: 460,
  opacity: 2,
  watchClipboard: true,
  unexpected: "discard me",
});
ok("known settings survive", settings.serverUrl === "https://dashboard.example" && settings.opacity === 2);
ok("unknown settings are discarded", !("unexpected" in settings));
ok("invalid settings object fails closed", Object.keys(parseSettings(["not", "settings"])).length === 0);
ok("invalid individual settings are omitted", parseSettings({ width: Infinity, opacity: 9 }).width === undefined);

console.log("\n=== IPC request and result boundaries ===");
ok("valid pair request", parsePairRequest({ serverUrl: "https://example", code: "123456", future: true })?.code === "123456");
ok("pair request rejects missing code", parsePairRequest({ serverUrl: "https://example" }) === null);
ok("pair request rejects arrays", parsePairRequest([]) === null);
ok("pair success result", parsePairResult({ ok: true, extra: "ignored" })?.ok === true);
ok("pair failure requires a string error", parsePairResult({ ok: false, error: 500 }) === null);
ok("viewer state accepts only known opacity levels", parseViewerState({ paired: true, serverUrl: "x", opacity: 1 })?.opacity === 1);
ok("viewer state rejects malformed opacity", parseViewerState({ paired: true, serverUrl: "x", opacity: 3 }) === null);

console.log("\n=== dashboard payload boundaries ===");
const scan = parseScan({
  id: "scan-1",
  at: 1_700_000_000_000,
  hull: "Obelisk",
  valueSell: 3_000_000_000,
  fleetAll: [{ name: "Talos", ships: 12 }],
  cargoList: [{ name: "Tritanium", qty: 1000 }],
  futureField: { supportedLater: true },
});
ok("valid scan parses", scan?.hull === "Obelisk" && scan.fleetAll?.[0]?.ships === 12);
ok("scan additive fields are discarded", scan !== null && !("futureField" in scan));
ok("numeric strings are normalized", parseScan({ id: "scan-2", at: "42", ehp: "1000" })?.ehp === 1000);
ok("scan requires an id", parseScan({ at: 1 }) === null);
ok("scan rejects non-finite numbers", parseScan({ id: "bad", at: 1, ehp: Infinity }) === null);
ok("scan rejects malformed nested fleet", parseScan({ id: "bad", at: 1, fleetAll: [{ name: "Talos" }] }) === null);
ok("scan rejects malformed nested cargo", parseScan({ id: "bad", at: 1, cargoList: "cargo" }) === null);

const bump = parseBumpEvent({ scanId: "scan-1", by: "pilot", count: 2, holdMs: 180000, remainingMs: 90000, future: true });
ok("valid bump parses", bump?.remainingMs === 90000);
ok("legacy bump without remaining parses", parseBumpEvent({ scanId: "scan-1", by: "pilot", count: 1, holdMs: 180000 }) !== null);
ok("bump rejects malformed duration", parseBumpEvent({ scanId: "scan-1", by: "pilot", count: 1, holdMs: "never" }) === null);
ok("bump-cleared requires scan id", parseBumpClearedEvent({ scanId: "scan-1" })?.scanId === "scan-1" && parseBumpClearedEvent({}) === null);
const hello = parseHelloEvent({
  name: "MiniLuv",
  protocolVersion: 1,
  capabilities: [...KNOWN_CAPABILITIES, "future-feature"],
});
ok("viewer declares protocol version 1", VIEWER_PROTOCOL_MIN_VERSION === 1 && VIEWER_PROTOCOL_MAX_VERSION === 1);
ok("version-1 hello parses", hello?.name === "MiniLuv" && hello.protocolVersion === 1);
ok("unknown capabilities are ignored", hello?.capabilities?.length === KNOWN_CAPABILITIES.length &&
   !(hello.capabilities as readonly string[]).includes("future-feature"));
ok("version-1 full capability set is fully compatible",
   hello !== null && negotiateProtocol(hello).compatibility === "fully-compatible");

const legacy = parseHelloEvent({ name: "Legacy MiniLuv" });
ok("legacy hello remains usable", legacy !== null &&
   negotiateProtocol(legacy).compatibility === "legacy" &&
   negotiateProtocol(legacy).capabilities.length === KNOWN_CAPABILITIES.length);
const partialRollout = parseHelloEvent({ name: "Partial MiniLuv", protocolVersion: 1 });
ok("either absent negotiation field uses legacy behavior", partialRollout !== null &&
   negotiateProtocol(partialRollout).compatibility === "legacy");

const limited = parseHelloEvent({
  name: "Limited MiniLuv",
  protocolVersion: 1,
  capabilities: [PROTOCOL_CAPABILITIES.scanFeed],
});
const limitedNegotiation = limited && negotiateProtocol(limited);
ok("missing capabilities produce a limited connection", limitedNegotiation?.compatibility === "limited-capability");
ok("missing capability is not enabled", limitedNegotiation !== null &&
   !limitedNegotiation.capabilities.includes(PROTOCOL_CAPABILITIES.bumpControl));

const future = parseHelloEvent({
  name: "Future MiniLuv",
  protocolVersion: 2,
  capabilities: [...KNOWN_CAPABILITIES],
});
ok("future protocol is identified without rejecting the hello", future !== null &&
   negotiateProtocol(future).compatibility === "newer-protocol");
ok("malformed protocol versions reject", parseHelloEvent({ name: "bad", protocolVersion: 1.5, capabilities: [] }) === null);
ok("malformed capability lists reject", parseHelloEvent({ name: "bad", protocolVersion: 1, capabilities: ["scan-feed", 7] }) === null);
ok("hello still requires dashboard name", parseHelloEvent({ protocolVersion: 1, capabilities: [] }) === null);
ok("claim requires non-empty token", parseClaimResponse({ token: "secret", future: true })?.token === "secret" && parseClaimResponse({ token: "" }) === null);

console.log("\n=== portable dashboard protocol fixture ===");
const ROOT = path.resolve(__dirname, "..", "..");
const fixturePath = process.env.DASHBOARD_VIEWER_PROTOCOL_FIXTURE ||
  path.join(ROOT, "tests", "fixtures", "viewer-protocol-v1.json");
let fixture: unknown = null;
try {
  fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  ok(process.env.DASHBOARD_VIEWER_PROTOCOL_FIXTURE ? "dashboard fixture loads" : "local fixture loads", true);
} catch (error) {
  ok("protocol fixture loads", false, error);
}

type UnknownRecord = Record<string, unknown>;
function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord : null;
}
function normalized(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}
function namedValue(root: unknown, names: readonly string[]): unknown {
  const wanted = new Set(names.map(normalized));
  const queue: unknown[] = [root];
  while (queue.length) {
    const current = queue.shift();
    const object = asRecord(current);
    if (!object) continue;
    for (const [key, value] of Object.entries(object)) {
      if (wanted.has(normalized(key))) return value;
      if (value !== null && typeof value === "object") queue.push(value);
    }
  }
  return undefined;
}
function decodedPayload(value: unknown): unknown {
  const object = asRecord(value);
  const payload = object?.data ?? object?.payload ?? value;
  if (typeof payload !== "string") return payload;
  try { return JSON.parse(payload); } catch { return payload; }
}
function eventValue(root: unknown, names: readonly string[]): unknown {
  const direct = namedValue(root, names);
  if (direct !== undefined) return decodedPayload(direct);

  const wanted = new Set(names.map(normalized));
  const queue: unknown[] = [root];
  while (queue.length) {
    const current = queue.shift();
    const object = asRecord(current);
    if (!object) continue;
    const discriminator = typeof object.event === "string" ? object.event :
      typeof object.type === "string" ? object.type : null;
    if (discriminator && wanted.has(normalized(discriminator))) return decodedPayload(object);
    Object.values(object).forEach((value) => {
      if (value !== null && typeof value === "object") queue.push(value);
    });
  }
  return undefined;
}
function response(value: unknown): unknown {
  return decodedPayload(asRecord(value)?.response ?? value);
}

const fixtureHello = parseHelloEvent(eventValue(fixture, ["hello", "helloEvent"]));
ok("fixture hello matches protocol v1", fixtureHello?.protocolVersion === 1 &&
   negotiateProtocol(fixtureHello).compatibility === "fully-compatible");
ok("fixture scan parses", parseScan(eventValue(fixture, ["scan", "scanEvent"])) !== null);
ok("fixture bump event parses", parseBumpEvent(eventValue(fixture, ["bumpEvent", "bump"])) !== null);
ok("fixture bump-cleared event parses", parseBumpClearedEvent(eventValue(fixture, ["bumpCleared", "bumpClearedEvent"])) !== null);
ok("fixture pairing response parses", parseClaimResponse(response(namedValue(fixture,
   ["pairingClaim", "claim", "claimResponse", "pairingResponse"]))) !== null);
ok("fixture vocabulary response parses", parseVocabulary(response(namedValue(fixture,
   ["vocabulary", "vocabularyResponse"]))) !== null);

console.log("\n=== vocabulary, clipboard, and status boundaries ===");
ok("valid vocabulary parses", parseVocabulary({ words: ["tritanium", "obelisk"], buildNumber: 123 })?.words.length === 2);
ok("vocabulary rejects mixed word arrays", parseVocabulary({ words: ["tritanium", 7] }) === null);
const clipboard = parseClipboardResult({
  on: true,
  stats: { sent: 1, ignored: 2, lastKind: "fit", lastAt: 10 },
  sentKind: "fit",
  delivered: 1,
  extra: "ignored",
});
ok("valid clipboard result parses", clipboard?.delivered === 1 && clipboard.stats.lastKind === "fit");
ok("clipboard rejects malformed stats", parseClipboardResult({ on: true, stats: { sent: "one" } }) === null);
ok("known status parses", parseConnectionStatus({ state: "reconnecting", detail: "2s", future: true })?.detail === "2s");
ok("compatibility status parses", parseConnectionStatus({
  state: "warn", compatibility: "newer-protocol", protocolVersion: 2,
})?.compatibility === "newer-protocol");
ok("unknown status rejects", parseConnectionStatus({ state: "teleporting" }) === null);

console.log("\n" + (fail === 0 ? "ALL " + pass + " PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
