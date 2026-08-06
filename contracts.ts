import {
  VALIDATION_LIMITS,
  boundedNumber,
  boundedNumberLike,
  boundedString,
  hasOnlyKeys,
  plainRecord,
  type UnknownRecord,
} from "./validation";

export type ClipboardKind = "fit" | "cargo";
export type OpacityLevel = 0 | 1 | 2;

// The dashboard owns the wire protocol. Keep this range explicit so a viewer
// release never silently claims compatibility with semantics it has not been
// tested against.
export const VIEWER_PROTOCOL_MIN_VERSION = 1;
export const VIEWER_PROTOCOL_MAX_VERSION = 1;

export const PROTOCOL_CAPABILITIES = {
  scanFeed: "scan-feed",
  bumpControl: "bump-control",
  clipboardRelay: "clipboard-relay",
  clipboardVocabulary: "clipboard-vocabulary",
  scanReplay: "scan-replay",
} as const;

export type KnownCapability = typeof PROTOCOL_CAPABILITIES[keyof typeof PROTOCOL_CAPABILITIES];
export const KNOWN_CAPABILITIES: readonly KnownCapability[] = Object.freeze(
  Object.values(PROTOCOL_CAPABILITIES),
);

export type ProtocolCompatibility =
  | "fully-compatible"
  | "legacy"
  | "limited-capability"
  | "newer-protocol";

export interface Settings {
  serverUrl?: string | null;
  // Read only for one-time migration from releases that stored the bearer
  // token in settings.json. New credentials live in credential.bin.
  token?: string | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: OpacityLevel;
  watchClipboard?: boolean;
}

export type ConnectionState =
  | "live"
  | "connecting"
  | "reconnecting"
  | "offline"
  | "error"
  | "unpaired"
  | "clip"
  | "warn";

export interface ConnectionStatus {
  state: ConnectionState;
  detail?: string;
  compatibility?: ProtocolCompatibility;
  protocolVersion?: number;
}

export interface FleetEntry {
  name: string;
  ships: number;
}

export interface CargoEntry {
  name: string;
  qty: number;
}

export interface Scan {
  id: string;
  at: number;
  scout?: string;
  hull?: string;
  system?: string;
  pilot?: string;
  scanGate?: string;
  headGate?: string;
  ammo?: string;
  sec?: string;
  prepped?: string;
  notes?: string;
  fitEft?: string;
  valueSell?: number;
  valueBuy?: number;
  valueSplit?: number;
  droppableSplit?: number;
  ehp?: number;
  fleetAll?: FleetEntry[];
  cargoList?: CargoEntry[];
}

export interface BumpEvent {
  scanId: string;
  by: string;
  count: number;
  holdMs: number;
  remainingMs?: number;
}

export interface ActiveBump extends BumpEvent {
  remainingMs: number;
  totalMs: number;
  receivedAt: number;
}

export interface BumpClearedEvent {
  scanId: string;
}

export interface Vocabulary {
  words: string[];
  buildNumber?: number;
}

export interface ClipboardCapture {
  kind: ClipboardKind;
  text: string;
}

export interface ClipboardRelayResponse {
  delivered: number;
}

export interface ClipboardStats {
  sent: number;
  ignored: number;
  lastKind: ClipboardKind | null;
  lastAt: number;
}

export interface ClipboardResult {
  on: boolean;
  stats: ClipboardStats;
  vocabulary?: number;
  ignored?: boolean;
  sentKind?: ClipboardKind;
  delivered?: number | null;
  error?: string | null;
}

export interface PairRequest {
  serverUrl: string;
  code: string;
}

export type PairResult = { ok: true } | { ok: false; error: string };
export type BumpResult = { ok: true } | { ok: false; error: string };

export interface ViewerState {
  paired: boolean;
  serverUrl: string;
  opacity: OpacityLevel;
}

export interface ClaimResponse {
  token: string;
}

export type ViewerReplayStatus = "snapshot" | "resumed" | "cursor-expired";

export interface ViewerReplayMetadata {
  status: ViewerReplayStatus;
}

export interface HelloEvent {
  name: string;
  protocolVersion?: number;
  capabilities?: KnownCapability[];
  replay?: ViewerReplayMetadata;
}

export interface ProtocolNegotiation {
  compatibility: ProtocolCompatibility;
  protocolVersion?: number;
  capabilities: KnownCapability[];
  missingCapabilities: KnownCapability[];
}

export interface IpcInvokeContract {
  pair: { request: PairRequest; result: PairResult };
  unpair: { request: undefined; result: boolean };
  state: { request: undefined; result: ViewerState };
  opacity: { request: number; result: OpacityLevel };
  bump: { request: string; result: BumpResult };
  clipwatch: { request: boolean | undefined; result: ClipboardResult };
  close: { request: undefined; result: void };
}

export interface IpcEventContract {
  scan: Scan;
  status: ConnectionStatus;
  clear: undefined;
  repair: undefined;
  bump: BumpEvent;
  bumpCleared: BumpClearedEvent;
  clipwatch: ClipboardResult;
  unpaired: undefined;
}

export interface ViewerApi {
  pair(serverUrl: string, code: string): Promise<PairResult>;
  unpair(): Promise<boolean>;
  state(): Promise<ViewerState>;
  setOpacity(level: number): Promise<OpacityLevel>;
  bump(scanId: string): Promise<BumpResult>;
  clipwatch(on?: boolean): Promise<ClipboardResult>;
  quit(): Promise<void>;
  onScan(listener: (scan: Scan) => void): void;
  onStatus(listener: (status: ConnectionStatus) => void): void;
  onClear(listener: () => void): void;
  onRepair(listener: () => void): void;
  onBump(listener: (bump: BumpEvent) => void): void;
  onBumpCleared(listener: (event: BumpClearedEvent) => void): void;
  onClipWatch(listener: (result: ClipboardResult) => void): void;
  onUnpaired(listener: () => void): void;
}

function isKnownCapability(value: string): value is KnownCapability {
  return (KNOWN_CAPABILITIES as readonly string[]).includes(value);
}

type ScanStringKey = "scout" | "hull" | "system" | "pilot" | "scanGate" | "headGate" |
  "ammo" | "sec" | "prepped" | "notes" | "fitEft";
type ScanNumberKey = "valueSell" | "valueBuy" | "valueSplit" | "droppableSplit" | "ehp";

function optionalString(source: UnknownRecord, key: ScanStringKey, target: Scan): boolean {
  if (!(key in source) || source[key] === undefined || source[key] === null) return true;
  const maximum = key === "notes" || key === "fitEft"
    ? VALIDATION_LIMITS.longText
    : VALIDATION_LIMITS.label;
  const value = boundedString(source[key], maximum);
  if (value === null) return false;
  target[key] = value;
  return true;
}

function optionalNumber(source: UnknownRecord, key: ScanNumberKey, target: Scan): boolean {
  if (!(key in source) || source[key] === undefined || source[key] === null) return true;
  const value = boundedNumberLike(source[key], {
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  });
  if (value === null) return false;
  target[key] = value;
  return true;
}

export function parseSettings(value: unknown): Settings {
  const source = plainRecord(value);
  if (!source) return {};
  const settings: Settings = {};
  const serverUrl = source.serverUrl === null ? null : boundedString(source.serverUrl, VALIDATION_LIMITS.url);
  if (serverUrl !== null || source.serverUrl === null) settings.serverUrl = serverUrl;
  const token = source.token === null ? null : boundedString(source.token, VALIDATION_LIMITS.token, 1);
  if ("token" in source) settings.token = token;
  for (const key of ["x", "y", "width", "height"] as const) {
    const number = boundedNumber(source[key], key === "x" || key === "y"
      ? { minimum: -1_000_000, maximum: 1_000_000, integer: true }
      : { minimum: 100, maximum: 10_000, integer: true });
    if (number !== null) settings[key] = number;
  }
  if (source.opacity === 0 || source.opacity === 1 || source.opacity === 2) settings.opacity = source.opacity;
  if (typeof source.watchClipboard === "boolean") settings.watchClipboard = source.watchClipboard;
  return settings;
}

export function parsePairRequest(value: unknown): PairRequest | null {
  const source = plainRecord(value);
  if (!source || !hasOnlyKeys(source, ["serverUrl", "code"])) return null;
  const serverUrl = boundedString(source.serverUrl, VALIDATION_LIMITS.url, 1);
  const code = boundedString(source.code, VALIDATION_LIMITS.pairingCode, 1);
  return serverUrl !== null && code !== null
    ? { serverUrl: serverUrl.trim(), code: code.trim() }
    : null;
}

export function parseScanId(value: unknown): string | null {
  return boundedString(value, VALIDATION_LIMITS.id, 1);
}

export function parseOpacity(value: unknown): OpacityLevel | null {
  return value === 0 || value === 1 || value === 2 ? value : null;
}

export function parseClipWatchRequest(value: unknown): boolean | undefined | null {
  return value === undefined || typeof value === "boolean" ? value : null;
}

function parseFleet(value: unknown): FleetEntry[] | null {
  if (!Array.isArray(value) || value.length > VALIDATION_LIMITS.listEntries) return null;
  const entries: FleetEntry[] = [];
  for (const item of value) {
    const source = plainRecord(item);
    if (!source) return null;
    const name = boundedString(source.name, VALIDATION_LIMITS.label);
    const ships = boundedNumberLike(source.ships, {
      minimum: 0, maximum: Number.MAX_SAFE_INTEGER, integer: true,
    });
    if (name === null || ships === null) return null;
    entries.push({ name, ships });
  }
  return entries;
}

function parseCargo(value: unknown): CargoEntry[] | null {
  if (!Array.isArray(value) || value.length > VALIDATION_LIMITS.listEntries) return null;
  const entries: CargoEntry[] = [];
  for (const item of value) {
    const source = plainRecord(item);
    if (!source) return null;
    const name = boundedString(source.name, VALIDATION_LIMITS.label);
    const qty = boundedNumberLike(source.qty, {
      minimum: 0, maximum: Number.MAX_SAFE_INTEGER, integer: true,
    });
    if (name === null || qty === null) return null;
    entries.push({ name, qty });
  }
  return entries;
}

export function parseScan(value: unknown): Scan | null {
  const source = plainRecord(value);
  if (!source) return null;
  const id = boundedString(source.id, VALIDATION_LIMITS.id, 1);
  const at = boundedNumberLike(source.at, {
    minimum: 0, maximum: VALIDATION_LIMITS.maxTimestamp, integer: true,
  });
  if (id === null || at === null) return null;

  const target: Scan = { id, at };
  for (const key of ["scout", "hull", "system", "pilot", "scanGate", "headGate", "ammo", "sec", "prepped", "notes", "fitEft"] as const) {
    if (!optionalString(source, key, target)) return null;
  }
  for (const key of ["valueSell", "valueBuy", "valueSplit", "droppableSplit", "ehp"] as const) {
    if (!optionalNumber(source, key, target)) return null;
  }
  if (source.fleetAll !== undefined && source.fleetAll !== null) {
    const fleet = parseFleet(source.fleetAll);
    if (!fleet) return null;
    target.fleetAll = fleet;
  }
  if (source.cargoList !== undefined && source.cargoList !== null) {
    const cargo = parseCargo(source.cargoList);
    if (!cargo) return null;
    target.cargoList = cargo;
  }
  return target;
}

export function parseBumpEvent(value: unknown): BumpEvent | null {
  const source = plainRecord(value);
  if (!source) return null;
  const scanId = boundedString(source.scanId, VALIDATION_LIMITS.id, 1);
  const by = boundedString(source.by, VALIDATION_LIMITS.label);
  const count = boundedNumber(source.count, {
    minimum: 1, maximum: Number.MAX_SAFE_INTEGER, integer: true,
  });
  const holdMs = boundedNumberLike(source.holdMs, {
    minimum: 0, maximum: VALIDATION_LIMITS.maxDurationMs, integer: true,
  });
  if (scanId === null || by === null || count === null || holdMs === null) return null;
  const remainingMs = source.remainingMs === undefined ? null : boundedNumberLike(source.remainingMs, {
    minimum: 0, maximum: VALIDATION_LIMITS.maxDurationMs, integer: true,
  });
  if (source.remainingMs !== undefined && remainingMs === null) return null;
  return remainingMs === null
    ? { scanId, by, count, holdMs }
    : { scanId, by, count, holdMs, remainingMs };
}

export function parseBumpClearedEvent(value: unknown): BumpClearedEvent | null {
  const source = plainRecord(value);
  const scanId = source ? boundedString(source.scanId, VALIDATION_LIMITS.id, 1) : null;
  return scanId === null ? null : { scanId };
}

export function parseViewerReplayMetadata(value: unknown): ViewerReplayMetadata | null {
  const replay = plainRecord(value);
  if (!replay || !hasOnlyKeys(replay, ["status"]) ||
      (replay.status !== "snapshot" && replay.status !== "resumed" &&
       replay.status !== "cursor-expired")) return null;
  return { status: replay.status };
}

export function parseHelloEvent(value: unknown): HelloEvent | null {
  const source = plainRecord(value);
  const name = source ? boundedString(source.name, VALIDATION_LIMITS.label, 1) : null;
  if (name === null) return null;

  const result: HelloEvent = { name };
  if (source?.protocolVersion !== undefined) {
    const version = boundedNumber(source.protocolVersion, {
      minimum: 1, maximum: Number.MAX_SAFE_INTEGER, integer: true,
    });
    if (version === null) return null;
    result.protocolVersion = version;
  }
  if (source?.capabilities !== undefined) {
    if (!Array.isArray(source.capabilities) || source.capabilities.length > VALIDATION_LIMITS.listEntries ||
        !source.capabilities.every((capability) =>
          boundedString(capability, VALIDATION_LIMITS.label, 1) !== null)) return null;
    result.capabilities = [...new Set(source.capabilities.filter(isKnownCapability))];
  }
  if (source?.replay !== undefined) {
    const replay = parseViewerReplayMetadata(source.replay);
    if (!replay) return null;
    result.replay = replay;
  }
  return result;
}

export function negotiateProtocol(hello: HelloEvent): ProtocolNegotiation {
  // Either missing field identifies a pre-negotiation dashboard. Preserve the
  // released viewer's behavior instead of interpreting an incomplete additive
  // rollout as a denial of every optional feature.
  if (hello.protocolVersion === undefined || hello.capabilities === undefined) {
    return {
      compatibility: "legacy",
      capabilities: [...KNOWN_CAPABILITIES],
      missingCapabilities: [],
    };
  }

  const advertised = new Set(hello.capabilities);
  const capabilities = KNOWN_CAPABILITIES.filter((capability) => advertised.has(capability));
  const missingCapabilities = KNOWN_CAPABILITIES.filter((capability) => !advertised.has(capability));
  if (hello.protocolVersion > VIEWER_PROTOCOL_MAX_VERSION) {
    return {
      compatibility: "newer-protocol",
      protocolVersion: hello.protocolVersion,
      capabilities,
      missingCapabilities,
    };
  }

  return {
    compatibility: missingCapabilities.length === 0 ? "fully-compatible" : "limited-capability",
    protocolVersion: hello.protocolVersion,
    capabilities,
    missingCapabilities,
  };
}

export function parseVocabulary(value: unknown): Vocabulary | null {
  const source = plainRecord(value);
  if (!source || !Array.isArray(source.words) || source.words.length === 0 ||
      source.words.length > VALIDATION_LIMITS.vocabularyEntries ||
      !source.words.every((word) => boundedString(word, VALIDATION_LIMITS.vocabularyWord, 1) !== null)) return null;
  const result: Vocabulary = { words: [...source.words] as string[] };
  if (source.buildNumber !== undefined) {
    const buildNumber = boundedNumber(source.buildNumber, {
      minimum: 0, maximum: Number.MAX_SAFE_INTEGER, integer: true,
    });
    if (buildNumber === null) return null;
    result.buildNumber = buildNumber;
  }
  return result;
}

export function parseClaimResponse(value: unknown): ClaimResponse | null {
  const source = plainRecord(value);
  const token = source ? boundedString(source.token, VALIDATION_LIMITS.token, 1) : null;
  return token ? { token } : null;
}

export function parseServerError(value: unknown): { error?: string; detail?: string; message?: string } {
  const source = plainRecord(value);
  if (!source) return {};
  const result: { error?: string; detail?: string; message?: string } = {};
  const error = boundedString(source.error, VALIDATION_LIMITS.label);
  const detail = boundedString(source.detail, VALIDATION_LIMITS.label);
  const message = boundedString(source.message, VALIDATION_LIMITS.label);
  if (error !== null) result.error = error;
  if (detail !== null) result.detail = detail;
  if (message !== null) result.message = message;
  return result;
}

export function parseConnectionStatus(value: unknown): ConnectionStatus | null {
  const source = plainRecord(value);
  if (!source || !hasOnlyKeys(source, ["state", "detail", "compatibility", "protocolVersion"])) return null;
  const states: readonly ConnectionState[] = ["live", "connecting", "reconnecting", "offline", "error", "unpaired", "clip", "warn"];
  if (!states.includes(source.state as ConnectionState)) return null;
  const detail = source.detail === undefined ? undefined : boundedString(source.detail, VALIDATION_LIMITS.label);
  if (detail === null) return null;
  const result: ConnectionStatus = { state: source.state as ConnectionState };
  if (detail !== undefined) result.detail = detail;
  if (source.compatibility !== undefined) {
    const compatibilities: readonly ProtocolCompatibility[] = [
      "fully-compatible", "legacy", "limited-capability", "newer-protocol",
    ];
    if (!compatibilities.includes(source.compatibility as ProtocolCompatibility)) return null;
    result.compatibility = source.compatibility as ProtocolCompatibility;
  }
  if (source.protocolVersion !== undefined) {
    const protocolVersion = boundedNumber(source.protocolVersion, {
      minimum: 1, maximum: Number.MAX_SAFE_INTEGER, integer: true,
    });
    if (protocolVersion === null) return null;
    result.protocolVersion = protocolVersion;
  }
  return result;
}

export function parseClipboardStats(value: unknown): ClipboardStats | null {
  const source = plainRecord(value);
  if (!source || !hasOnlyKeys(source, ["sent", "ignored", "lastKind", "lastAt"])) return null;
  const counterBounds = { minimum: 0, maximum: Number.MAX_SAFE_INTEGER, integer: true } as const;
  const sent = boundedNumber(source.sent, counterBounds);
  const ignored = boundedNumber(source.ignored, counterBounds);
  const lastAt = boundedNumber(source.lastAt, {
    minimum: 0, maximum: VALIDATION_LIMITS.maxTimestamp, integer: true,
  });
  const lastKind = source.lastKind;
  if (sent === null || ignored === null || lastAt === null ||
      (lastKind !== null && lastKind !== "fit" && lastKind !== "cargo")) return null;
  return { sent, ignored, lastAt, lastKind };
}

export function parseClipboardResult(value: unknown): ClipboardResult | null {
  const source = plainRecord(value);
  if (!source || !hasOnlyKeys(source, [
    "on", "stats", "vocabulary", "ignored", "sentKind", "delivered", "error",
  ]) || typeof source.on !== "boolean") return null;
  const stats = parseClipboardStats(source.stats);
  if (!stats) return null;
  const result: ClipboardResult = { on: source.on, stats };
  if (source.vocabulary !== undefined) {
    const vocabulary = boundedNumber(source.vocabulary, {
      minimum: 0, maximum: VALIDATION_LIMITS.vocabularyEntries, integer: true,
    });
    if (vocabulary === null) return null;
    result.vocabulary = vocabulary;
  }
  if (source.ignored !== undefined) {
    if (typeof source.ignored !== "boolean") return null;
    result.ignored = source.ignored;
  }
  if (source.sentKind !== undefined) {
    if (source.sentKind !== "fit" && source.sentKind !== "cargo") return null;
    result.sentKind = source.sentKind;
  }
  if (source.delivered !== undefined) {
    const delivered = source.delivered === null ? null : boundedNumber(source.delivered, {
      minimum: 0, maximum: Number.MAX_SAFE_INTEGER, integer: true,
    });
    if (delivered === null && source.delivered !== null) return null;
    result.delivered = delivered;
  }
  if (source.error !== undefined) {
    if (source.error !== null && boundedString(source.error, VALIDATION_LIMITS.label) === null) return null;
    result.error = source.error as string | null;
  }
  return result;
}

export function parsePairResult(value: unknown): PairResult | null {
  const source = plainRecord(value);
  if (!source || typeof source.ok !== "boolean") return null;
  if (source.ok) return hasOnlyKeys(source, ["ok"]) ? { ok: true } : null;
  if (!hasOnlyKeys(source, ["ok", "error"])) return null;
  const error = boundedString(source.error, VALIDATION_LIMITS.label, 1);
  return error === null ? null : { ok: false, error };
}

export function parseBumpResult(value: unknown): BumpResult | null {
  return parsePairResult(value);
}

export function parseViewerState(value: unknown): ViewerState | null {
  const source = plainRecord(value);
  if (!source || !hasOnlyKeys(source, ["paired", "serverUrl", "opacity"]) ||
      typeof source.paired !== "boolean" || boundedString(source.serverUrl, VALIDATION_LIMITS.url) === null ||
      (source.opacity !== 0 && source.opacity !== 1 && source.opacity !== 2)) return null;
  return { paired: source.paired, serverUrl: source.serverUrl as string, opacity: source.opacity };
}

export function parseClipboardRelayResponse(value: unknown): ClipboardRelayResponse | null {
  const source = plainRecord(value);
  if (!source) return null;
  const delivered = boundedNumber(source.delivered, {
    minimum: 0, maximum: Number.MAX_SAFE_INTEGER, integer: true,
  });
  return delivered === null ? null : { delivered };
}

export function parseNoArguments(value: unknown): value is undefined {
  return value === undefined;
}
