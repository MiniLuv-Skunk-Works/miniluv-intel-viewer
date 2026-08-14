import {
  KNOWN_CAPABILITIES,
  PROTOCOL_CAPABILITIES,
  VIEWER_PROTOCOL_MAX_VERSION,
  VIEWER_PROTOCOL_MIN_VERSION,
  defaultUserPreferences,
  negotiateProtocol,
  parseBumpClearedEvent,
  parseBumpEvent,
  parseBumpResponse,
  parseClaimResponse,
  parseCombatScenario,
  parseClipboardRelayResponse,
  parseClipboardCapture,
  parseClipboardResult,
  parsePilotClipboardResult,
  parseConnectionStatus,
  parseHelloEvent,
  parseNoArguments,
  parseOpacity,
  parsePairRequest,
  parsePairResult,
  parseScan,
  parseScanRemovedEvent,
  parseScanId,
  parseScanRevisionId,
  parseScenarioCalculationOutcome,
  parseViewerScenarioCalculationRequest,
  parseViewerScenarioCalculationResponse,
  parseSettings,
  parseSettingsDocument,
  parseViewerState,
  parseViewerReplayMetadata,
  parseVocabulary,
  parseUserPreferences,
} from "../src/contracts";
import * as fs from "node:fs";
import * as path from "node:path";
import { ok } from "./support/assertions";

console.log("\n=== settings boundary ===");
const settings = parseSettings({
  serverUrl: "https://dashboard.example",
  token: "token",
  x: 10,
  y: 20,
  width: 380,
  height: 460,
  windowPlacement: {
    bounds: { x: -1200, y: 40, width: 380, height: 460 },
    displayId: 2,
    workArea: { x: -1280, y: 0, width: 1280, height: 1024 },
    scaleFactor: 1.25,
  },
  opacity: 2,
  watchClipboard: true,
  watchPilotClipboard: true,
  unexpected: "discard me",
});
ok(
  "known settings survive",
  settings.serverUrl === "https://dashboard.example" && settings.opacity === 2,
);
ok("pilot clipboard preference survives", settings.watchPilotClipboard === true);
ok(
  "missing or malformed pilot clipboard preferences default off",
  parseSettings({}).watchPilotClipboard === false &&
    parseSettings({ watchPilotClipboard: "yes" }).watchPilotClipboard === false,
);
ok(
  "display-aware placement survives validation",
  settings.windowPlacement?.displayId === 2 && settings.windowPlacement.workArea.x === -1280,
);
ok("unknown settings are discarded", !("unexpected" in settings));
ok(
  "invalid settings object fails closed",
  Object.keys(parseSettings(["not", "settings"])).length === 0,
);
ok("stored settings documents reject non-object roots", parseSettingsDocument([]) === null);
ok(
  "invalid individual settings are omitted",
  parseSettings({ width: Infinity, opacity: 9 }).width === undefined,
);
ok(
  "malformed placement is omitted",
  parseSettings({
    windowPlacement: {
      bounds: { x: 0, y: 0, width: Infinity, height: 460 },
      displayId: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      scaleFactor: 1,
    },
  }).windowPlacement === undefined,
);
ok(
  "invalid legacy credentials are marked for removal",
  parseSettings({ token: "x".repeat(8_193) }).token === null,
);

console.log("\n=== IPC request and result boundaries ===");
ok(
  "valid pair request",
  parsePairRequest({ serverUrl: "https://example", code: "123456" })?.code === "123456",
);
ok(
  "pair request rejects missing code",
  parsePairRequest({ serverUrl: "https://example" }) === null,
);
ok("pair request rejects arrays", parsePairRequest([]) === null);
ok(
  "pair request rejects extra keys",
  parsePairRequest({ serverUrl: "https://example", code: "123456", future: true }) === null,
);
ok("pair request rejects exotic objects", parsePairRequest(new Date()) === null);
ok("pair success result", parsePairResult({ ok: true })?.ok === true);
ok("pair result rejects extra keys", parsePairResult({ ok: true, extra: "ignored" }) === null);
ok("pair failure requires a string error", parsePairResult({ ok: false, error: 500 }) === null);
ok(
  "viewer state accepts only known opacity levels",
  parseViewerState({ paired: true, serverUrl: "x", opacity: 1 })?.opacity === 1,
);
ok(
  "viewer state rejects malformed opacity",
  parseViewerState({ paired: true, serverUrl: "x", opacity: 3 }) === null,
);
ok(
  "opacity requests are strict",
  parseOpacity(2) === 2 && parseOpacity(2.4) === null && parseOpacity("1") === null,
);
ok(
  "scan ids are bounded",
  parseScanId("scan-1") === "scan-1" &&
    parseScanId("") === null &&
    parseScanId("x".repeat(257)) === null,
);
ok(
  "scan revision ids are independent and SSE-safe",
  parseScanRevisionId("revision-1") === "revision-1" &&
    parseScanRevisionId("scan-1") === "scan-1" &&
    parseScanRevisionId("bad\nrevision") === null,
);
ok("no-argument calls are strict", parseNoArguments(undefined) && !parseNoArguments({}));

console.log("\n=== dashboard payload boundaries ===");
function scanEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "scan-1",
    analysisId: "00000000-0000-4000-8000-000000000001",
    at: 1_700_000_000_000,
    scout: "Scout",
    confidence: "full-fit",
    hull: "Obelisk",
    system: "Uedama",
    pilot: null,
    scanGate: null,
    headGate: null,
    valueSell: null,
    valueBuy: null,
    valueSplit: null,
    droppableSplit: null,
    notes: null,
    fitEft: null,
    cargoList: [],
    ...overrides,
  };
}

const scan = parseScan(
  scanEvent({
    valueSell: 3_000_000_000,
    cargoList: [{ name: "Tritanium", qty: 1000 }],
    futureField: { supportedLater: true },
  }),
);
ok("valid scan parses", scan?.hull === "Obelisk" && scan.cargoList?.[0]?.qty === 1000);
ok("scan additive fields are discarded", scan !== null && !("futureField" in scan));
ok(
  "numeric strings are normalized",
  parseScan(scanEvent({ id: "scan-2", at: "42", valueSell: "1000" }))?.valueSell === 1000,
);
ok(
  "finite decimal scan values remain wire-compatible",
  parseScan(
    scanEvent({
      id: "scan-decimals",
      at: 1_700_000_000_000,
      valueSell: 3_000_000_000.42,
      valueBuy: "2999999999.75",
      droppableSplit: 12345.5,
    }),
  )?.valueBuy === 2_999_999_999.75,
);
ok("scan requires an id", parseScan(scanEvent({ id: undefined })) === null);
ok("scan rejects non-finite numbers", parseScan(scanEvent({ valueSell: Infinity })) === null);
ok(
  "scan rejects removed protocol-v1 calculation fields",
  ["ehp", "ammo", "fleetAll", "sec", "prepped", "tankState", "implant"].every(
    (field) => parseScan(scanEvent({ [field]: null })) === null,
  ),
);
ok("scan rejects malformed nested cargo", parseScan(scanEvent({ cargoList: "cargo" })) === null);
ok("scan rejects oversized text", parseScan(scanEvent({ notes: "x".repeat(64_001) })) === null);
ok(
  "scan rejects oversized nested lists",
  parseScan(
    scanEvent({
      cargoList: Array.from({ length: 1_001 }, () => ({ name: "Tritanium", qty: 1 })),
    }),
  ) === null,
);
ok(
  "scan rejects unsafe and negative numbers",
  parseScan(scanEvent({ at: -1 })) === null &&
    parseScan(scanEvent({ valueSell: Number.MAX_SAFE_INTEGER + 1 })) === null,
);

const bump = parseBumpEvent({
  scanId: "scan-1",
  at: 1_700_000_000_000,
  by: "pilot",
  count: 2,
  holdMs: 180000,
  remainingMs: 90000,
  future: true,
});
ok(
  "valid bump retains server timing",
  bump?.at === 1_700_000_000_000 && bump.remainingMs === 90000,
);
ok(
  "truly legacy bump without server timing parses",
  parseBumpEvent({ scanId: "scan-1", by: "pilot", count: 1, holdMs: 180000 }) !== null,
);
ok(
  "older bump with at but no remaining parses",
  parseBumpEvent({
    scanId: "scan-1",
    at: 1_700_000_000_000,
    by: "pilot",
    count: 1,
    holdMs: 180000,
  })?.at === 1_700_000_000_000,
);
ok(
  "dashboard bump response parses as an event",
  parseBumpResponse({
    scanId: "scan-1",
    at: 1_700_000_000_000,
    by: "pilot",
    count: 1,
    holdMs: 180000,
  })?.scanId === "scan-1",
);
ok(
  "IPC acknowledgement is not a dashboard bump response",
  parseBumpResponse({ ok: true }) === null,
);
ok(
  "bump rejects malformed duration",
  parseBumpEvent({ scanId: "scan-1", by: "pilot", count: 1, holdMs: "never" }) === null,
);
ok(
  "bump rejects malformed server timestamp",
  parseBumpEvent({ scanId: "scan-1", at: -1, by: "pilot", count: 1, holdMs: 180000 }) === null &&
    parseBumpEvent({
      scanId: "scan-1",
      at: 8_640_000_000_000_001,
      by: "pilot",
      count: 1,
      holdMs: 180000,
    }) === null,
);
ok(
  "bump rejects out-of-range values",
  parseBumpEvent({ scanId: "scan-1", by: "pilot", count: 0, holdMs: 1 }) === null &&
    parseBumpEvent({ scanId: "scan-1", by: "pilot", count: 1, holdMs: 86_400_001 }) === null &&
    parseBumpEvent({
      scanId: "scan-1",
      by: "pilot",
      count: 1,
      holdMs: 86_400_000,
      remainingMs: 86_400_001,
    }) === null,
);
ok(
  "bump-cleared requires scan id",
  parseBumpClearedEvent({ scanId: "scan-1" })?.scanId === "scan-1" &&
    parseBumpClearedEvent({}) === null,
);
ok(
  "scan-removed requires only a bounded scan id",
  parseScanRemovedEvent({ scanId: "scan-1" })?.scanId === "scan-1" &&
    parseScanRemovedEvent({ scanId: "scan-1", extra: true }) === null,
);
const hello = parseHelloEvent({
  name: "MiniLuv",
  protocolVersion: 2,
  capabilities: [...KNOWN_CAPABILITIES, "future-feature"],
  replay: { status: "resumed" },
});
ok(
  "viewer declares protocol version 2",
  VIEWER_PROTOCOL_MIN_VERSION === 2 && VIEWER_PROTOCOL_MAX_VERSION === 2,
);
ok(
  "version-2 replay hello parses",
  hello?.name === "MiniLuv" && hello.protocolVersion === 2 && hello.replay?.status === "resumed",
);
ok(
  "unknown capabilities are ignored",
  hello?.capabilities?.length === KNOWN_CAPABILITIES.length &&
    !(hello.capabilities as readonly string[]).includes("future-feature"),
);
ok(
  "version-2 full capability set is fully compatible",
  hello !== null && negotiateProtocol(hello).compatibility === "fully-compatible",
);
ok(
  "pilot clipboard support is capability-negotiated",
  KNOWN_CAPABILITIES.includes(PROTOCOL_CAPABILITIES.clipboardPilotRelay),
);

const legacy = parseHelloEvent({ name: "Legacy MiniLuv" });
ok(
  "legacy hello is rejected as older protocol",
  legacy !== null &&
    negotiateProtocol(legacy).compatibility === "older-protocol" &&
    negotiateProtocol(legacy).capabilities.length === 0,
);
const partialRollout = parseHelloEvent({ name: "Partial MiniLuv", protocolVersion: 1 });
ok(
  "either absent negotiation field is incompatible",
  partialRollout !== null && negotiateProtocol(partialRollout).compatibility === "older-protocol",
);

const limited = parseHelloEvent({
  name: "Limited MiniLuv",
  protocolVersion: 2,
  capabilities: [PROTOCOL_CAPABILITIES.scanFeed],
});
const limitedNegotiation = limited && negotiateProtocol(limited);
ok(
  "missing capabilities produce a limited connection",
  limitedNegotiation?.compatibility === "limited-capability",
);
ok(
  "missing capability is not enabled",
  limitedNegotiation !== null &&
    !limitedNegotiation.capabilities.includes(PROTOCOL_CAPABILITIES.bumpControl),
);

const future = parseHelloEvent({
  name: "Future MiniLuv",
  protocolVersion: 3,
  capabilities: [...KNOWN_CAPABILITIES],
});
ok(
  "future protocol is identified without rejecting the hello",
  future !== null && negotiateProtocol(future).compatibility === "newer-protocol",
);
const old = parseHelloEvent({
  name: "Old MiniLuv",
  protocolVersion: 1,
  capabilities: [...KNOWN_CAPABILITIES],
});
ok(
  "protocol v1 is identified as incompatible",
  old !== null && negotiateProtocol(old).compatibility === "older-protocol",
);
ok(
  "malformed protocol versions reject",
  parseHelloEvent({ name: "bad", protocolVersion: 2.5, capabilities: [] }) === null,
);
ok(
  "malformed capability lists reject",
  parseHelloEvent({ name: "bad", protocolVersion: 2, capabilities: ["scan-feed", 7] }) === null,
);
ok(
  "hello still requires dashboard name",
  parseHelloEvent({ protocolVersion: 2, capabilities: [] }) === null,
);
ok(
  "all replay states parse",
  ["snapshot", "resumed", "cursor-expired"].every(
    (status) => parseViewerReplayMetadata({ status })?.status === status,
  ),
);
ok(
  "malformed replay metadata rejects",
  parseViewerReplayMetadata({ status: "unknown" }) === null &&
    parseViewerReplayMetadata({ status: "resumed", extra: true }) === null,
);
ok(
  "claim requires non-empty token",
  parseClaimResponse({ token: "secret", future: true })?.token === "secret" &&
    parseClaimResponse({ token: "" }) === null,
);
ok("claim rejects oversized tokens", parseClaimResponse({ token: "x".repeat(8_193) }) === null);

console.log("\n=== portable dashboard protocol fixture ===");
const ROOT = path.resolve(__dirname, "..", "..");
const fixturePath =
  process.env.DASHBOARD_VIEWER_PROTOCOL_FIXTURE ||
  path.join(ROOT, "tests", "fixtures", "viewer-protocol-v2.json");
let fixture: unknown = null;
try {
  fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  ok(
    process.env.DASHBOARD_VIEWER_PROTOCOL_FIXTURE
      ? "dashboard fixture loads"
      : "local fixture loads",
    true,
  );
} catch (error) {
  ok("protocol fixture loads", false, error);
}

type UnknownRecord = Record<string, unknown>;
function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
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
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
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
    const discriminator =
      typeof object.event === "string"
        ? object.event
        : typeof object.type === "string"
          ? object.type
          : null;
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
ok(
  "fixture hello matches protocol v2",
  fixtureHello?.protocolVersion === 2 &&
    negotiateProtocol(fixtureHello).compatibility === "fully-compatible",
);
const fixtureV1 = JSON.parse(
  fs.readFileSync(path.join(ROOT, "tests", "fixtures", "viewer-protocol-v1.json"), "utf8"),
) as unknown;
const fixtureV1Hello = parseHelloEvent(eventValue(fixtureV1, ["hello", "helloEvent"]));
ok(
  "protocol-v1 fixture is retained only for rejection",
  fixtureV1Hello !== null &&
    negotiateProtocol(fixtureV1Hello).compatibility === "older-protocol" &&
    parseScan(eventValue(fixtureV1, ["scan", "scanEvent"])) === null,
);
ok("fixture scan parses", parseScan(eventValue(fixture, ["scan", "scanEvent"])) !== null);
const fixtureApiRequests = asRecord(asRecord(fixture)?.apiRequests);
ok(
  "fixture contains a bounded canonical pilot relay",
  parseClipboardCapture(fixtureApiRequests?.clipboardRelay)?.kind === "pilot",
);
const fixtureScenarioRequest = parseViewerScenarioCalculationRequest(
  fixtureApiRequests?.scenarioCalculation,
);
ok(
  "fixture scenario request is bounded and mutually exclusive",
  fixtureScenarioRequest?.scanIds.length === 3 &&
    fixtureScenarioRequest.scenario.implant === "none",
);
const fixtureBump = parseBumpEvent(eventValue(fixture, ["bumpEvent", "bump"]));
ok(
  "fixture bump event carries server timing",
  fixtureBump?.at === 1_754_000_005_000 && fixtureBump.remainingMs === 180000,
);
const fixtureApiResponses = asRecord(asRecord(fixture)?.apiResponses);
const fixtureScenarioResponse = parseViewerScenarioCalculationResponse(
  fixtureApiResponses?.scenarioCalculation,
);
ok(
  "fixture scenario response parses every result status",
  fixtureScenarioResponse?.results.map((result) => result.status).join(",") ===
    "ready,unavailable,not-found",
);
const fixtureBumpResponse = parseBumpResponse(response(fixtureApiResponses?.bump));
ok(
  "fixture bump API response carries server timing",
  fixtureBumpResponse?.at === 1_754_000_005_000 && fixtureBumpResponse.remainingMs === 180000,
);
ok(
  "fixture bump-cleared event parses",
  parseBumpClearedEvent(eventValue(fixture, ["bumpCleared", "bumpClearedEvent"])) !== null,
);
ok(
  "fixture scan-removed event parses",
  parseScanRemovedEvent(eventValue(fixture, ["scanRemoved"])) !== null,
);
ok(
  "fixture pairing response parses",
  parseClaimResponse(
    response(namedValue(fixture, ["pairingClaim", "claim", "claimResponse", "pairingResponse"])),
  ) !== null,
);
ok(
  "fixture vocabulary response parses",
  parseVocabulary(response(namedValue(fixture, ["vocabulary", "vocabularyResponse"]))) !== null,
);
ok(
  "fixture clipboard relay response parses",
  parseClipboardRelayResponse(response(fixtureApiResponses?.clipboardRelay))?.delivered === 1,
);
const fixtureReplay = asRecord(namedValue(fixture, ["replay"]));
const fixtureReplayStates = asRecord(fixtureReplay?.states);
ok(
  "fixture replay cursor is a valid revision distinct from the stable scan ID",
  parseScanRevisionId(fixtureReplay?.scanEventId) !== null &&
    fixtureReplay?.scanEventId !== parseScan(eventValue(fixture, ["scan", "scanEvent"]))?.id,
);
ok(
  "fixture Last-Event-ID is portable",
  fixtureReplay?.lastEventIdHeader === fixtureReplay?.scanEventId,
);
ok(
  "fixture cursor-expiry behavior parses",
  parseViewerReplayMetadata(fixtureReplayStates?.cursorExpired)?.status === "cursor-expired",
);

console.log("\n=== scenario calculation boundaries ===");
const scenario = {
  state: "prepped",
  securityStatus: "0.5",
  tankState: "active",
  implant: "none",
};
ok("combat scenario parses", parseCombatScenario(scenario)?.tankState === "active");
ok("invalid implant rejects", parseCombatScenario({ ...scenario, implant: "both" }) === null);
const legacyPreferences = defaultUserPreferences() as unknown as Record<string, unknown>;
delete legacyPreferences.combatScenario;
ok(
  "older preferences receive the safe universal scenario",
  parseUserPreferences(legacyPreferences)?.combatScenario.state === "prepped" &&
    parseUserPreferences(legacyPreferences)?.combatScenario.securityStatus === "0.5",
);
ok(
  "explicit malformed scenarios do not silently reset",
  parseUserPreferences({
    ...defaultUserPreferences(),
    combatScenario: { ...scenario, implant: "both" },
  }) === null,
);
ok(
  "duplicate and oversized batches reject",
  parseViewerScenarioCalculationRequest({ scanIds: ["a", "a"], scenario }) === null &&
    parseViewerScenarioCalculationRequest({
      scanIds: Array.from({ length: 26 }, (_, index) => `scan-${index}`),
      scenario,
    }) === null,
);
ok(
  "unbounded response profile maps reject",
  parseViewerScenarioCalculationResponse({
    scenario,
    results: [
      {
        scanId: "scan-1",
        status: "ready",
        tank: {
          selectedProfile: "Void (kin/therm)",
          selectedEhp: 1,
          ehpByProfile: Object.fromEntries(
            Array.from({ length: 17 }, (_, index) => [`profile-${index}`, 1]),
          ),
          overridden: false,
        },
        requirements: [],
      },
    ],
  }) === null,
);
ok(
  "calculation IPC outcomes validate strictly",
  parseScenarioCalculationOutcome({
    ok: true,
    response: fixtureScenarioResponse,
  })?.ok === true &&
    parseScenarioCalculationOutcome({
      ok: false,
      reason: "rate-limited",
      message: "slow down",
    })?.ok === false &&
    parseScenarioCalculationOutcome({
      ok: false,
      reason: "secret",
      message: "bad",
    }) === null,
);

console.log("\n=== vocabulary, clipboard, and status boundaries ===");
ok(
  "valid vocabulary parses",
  parseVocabulary({ words: ["tritanium", "obelisk"], buildNumber: 123 })?.words.length === 2,
);
ok("vocabulary rejects mixed word arrays", parseVocabulary({ words: ["tritanium", 7] }) === null);
const clipboard = parseClipboardResult({
  on: true,
  stats: { sent: 1, ignored: 2, lastKind: "pilot", lastAt: 10 },
  sentKind: "pilot",
  delivered: 1,
});
ok(
  "valid clipboard result parses",
  clipboard?.delivered === 1 && clipboard.stats.lastKind === "pilot",
);
ok(
  "pilot clipboard control results are strict",
  parsePilotClipboardResult({ on: true, available: true })?.available === true &&
    parsePilotClipboardResult({ on: true, available: true, extra: true }) === null,
);
ok(
  "clipboard rejects malformed stats",
  parseClipboardResult({ on: true, stats: { sent: "one" } }) === null,
);
ok(
  "clipboard IPC results reject extra keys",
  parseClipboardResult({
    on: true,
    stats: { sent: 1, ignored: 2, lastKind: null, lastAt: 0 },
    future: true,
  }) === null,
);
ok(
  "known status parses",
  parseConnectionStatus({ state: "reconnecting", detail: "2s" })?.detail === "2s",
);
ok(
  "status IPC rejects extra keys",
  parseConnectionStatus({ state: "live", future: true }) === null,
);
ok(
  "compatibility status parses",
  parseConnectionStatus({
    state: "warn",
    compatibility: "newer-protocol",
    protocolVersion: 3,
  })?.compatibility === "newer-protocol",
);
ok("unknown status rejects", parseConnectionStatus({ state: "teleporting" }) === null);
