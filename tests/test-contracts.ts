import {
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
ok("hello requires dashboard name", parseHelloEvent({ name: "MiniLuv", protocolVersion: 1 })?.name === "MiniLuv");
ok("claim requires non-empty token", parseClaimResponse({ token: "secret", future: true })?.token === "secret" && parseClaimResponse({ token: "" }) === null);

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
ok("unknown status rejects", parseConnectionStatus({ state: "teleporting" }) === null);

console.log("\n" + (fail === 0 ? "ALL " + pass + " PASSED" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
