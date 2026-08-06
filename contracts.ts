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

export interface QuietHours {
  enabled: boolean;
  startMinute: number;
  endMinute: number;
}

export interface AlertPreferences {
  enabled: boolean;
  muted: boolean;
  includeSensitiveDetails: boolean;
  minimumSplitValue: number | null;
  hulls: string[];
  systems: string[];
  routes: string[];
  quietHours: QuietHours;
}

export interface FilterPreferences {
  query: string;
  minimumSplitValue: number | null;
}

export interface UserPreferences {
  alerts: AlertPreferences;
  filters: FilterPreferences;
}

export const DEFAULT_USER_PREFERENCES: Readonly<UserPreferences> = Object.freeze({
  alerts: Object.freeze({
    enabled: false,
    muted: false,
    includeSensitiveDetails: false,
    minimumSplitValue: null,
    hulls: Object.freeze([]) as unknown as string[],
    systems: Object.freeze([]) as unknown as string[],
    routes: Object.freeze([]) as unknown as string[],
    quietHours: Object.freeze({ enabled: false, startMinute: 22 * 60, endMinute: 7 * 60 }),
  }),
  filters: Object.freeze({ query: "", minimumSplitValue: null }),
});

export function defaultUserPreferences(): UserPreferences {
  return {
    alerts: {
      ...DEFAULT_USER_PREFERENCES.alerts,
      hulls: [],
      systems: [],
      routes: [],
      quietHours: { ...DEFAULT_USER_PREFERENCES.alerts.quietHours },
    },
    filters: { ...DEFAULT_USER_PREFERENCES.filters },
  };
}

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

export type KnownCapability = (typeof PROTOCOL_CAPABILITIES)[keyof typeof PROTOCOL_CAPABILITIES];
export const KNOWN_CAPABILITIES: readonly KnownCapability[] = Object.freeze(
  Object.values(PROTOCOL_CAPABILITIES),
);

export type ProtocolCompatibility =
  "fully-compatible" | "legacy" | "limited-capability" | "newer-protocol";

export interface StoredRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowPlacement {
  bounds: StoredRectangle;
  displayId: number;
  workArea: StoredRectangle;
  scaleFactor: number;
}

export interface Settings {
  serverUrl?: string | null;
  // Read only for one-time migration from releases that stored the bearer
  // token in settings.json. New credentials live in credential.bin.
  token?: string | null;
  // Read only for migration from releases that stored flat window bounds.
  // New saves use windowPlacement so the display context is retained.
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  windowPlacement?: WindowPlacement;
  opacity?: OpacityLevel;
  watchClipboard?: boolean;
  preferences?: UserPreferences;
  updateCache?: UpdateCache;
}

export type ConnectionState =
  | "live"
  | "connecting"
  | "reconnecting"
  | "replaying"
  | "stale"
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
  lastEventAt?: number;
}

export interface UserNotice {
  level: "info" | "warn" | "error";
  message: string;
}

export interface DiagnosticError {
  at: number;
  code: string;
  message: string;
}

export interface DiagnosticsSnapshot {
  appVersion: string;
  serverOrigin: string;
  connection: ConnectionStatus;
  errors: DiagnosticError[];
  update: UpdateInfo;
}

export type UpdateStatus = "unknown" | "checking" | "up-to-date" | "available" | "error";

export interface UpdateInfo {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  title?: string;
  notes?: string;
  publishedAt?: string;
  releaseUrl?: string;
  checkedAt?: number;
  error?: string;
}

export interface UpdateCache {
  checkedAt: number;
  release: {
    version: string;
    title: string;
    notes: string;
    publishedAt: string;
    releaseUrl: string;
  } | null;
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
  at?: number;
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
  preferences: { request: undefined; result: UserPreferences };
  savePreferences: { request: UserPreferences; result: UserPreferences };
  diagnostics: { request: undefined; result: DiagnosticsSnapshot };
  checkUpdate: { request: undefined; result: UpdateInfo };
  openUpdate: { request: undefined; result: boolean };
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
  notice: UserNotice;
  update: UpdateInfo;
}

export interface ViewerApi {
  pair(serverUrl: string, code: string): Promise<PairResult>;
  unpair(): Promise<boolean>;
  state(): Promise<ViewerState>;
  setOpacity(level: number): Promise<OpacityLevel>;
  bump(scanId: string): Promise<BumpResult>;
  clipwatch(on?: boolean): Promise<ClipboardResult>;
  preferences(): Promise<UserPreferences>;
  savePreferences(preferences: UserPreferences): Promise<UserPreferences>;
  diagnostics(): Promise<DiagnosticsSnapshot>;
  checkUpdate(): Promise<UpdateInfo>;
  openUpdate(): Promise<boolean>;
  quit(): Promise<void>;
  onScan(listener: (scan: Scan) => void): void;
  onStatus(listener: (status: ConnectionStatus) => void): void;
  onClear(listener: () => void): void;
  onRepair(listener: () => void): void;
  onBump(listener: (bump: BumpEvent) => void): void;
  onBumpCleared(listener: (event: BumpClearedEvent) => void): void;
  onClipWatch(listener: (result: ClipboardResult) => void): void;
  onUnpaired(listener: () => void): void;
  onNotice(listener: (notice: UserNotice) => void): void;
  onUpdate(listener: (update: UpdateInfo) => void): void;
}

function isKnownCapability(value: string): value is KnownCapability {
  return (KNOWN_CAPABILITIES as readonly string[]).includes(value);
}

type ScanStringKey =
  | "scout"
  | "hull"
  | "system"
  | "pilot"
  | "scanGate"
  | "headGate"
  | "ammo"
  | "sec"
  | "prepped"
  | "notes"
  | "fitEft";
type ScanNumberKey = "valueSell" | "valueBuy" | "valueSplit" | "droppableSplit" | "ehp";

function optionalString(source: UnknownRecord, key: ScanStringKey, target: Scan): boolean {
  if (!(key in source) || source[key] === undefined || source[key] === null) return true;
  const maximum =
    key === "notes" || key === "fitEft" ? VALIDATION_LIMITS.longText : VALIDATION_LIMITS.label;
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

function parseStoredRectangle(value: unknown, minimumSize: number): StoredRectangle | null {
  const source = plainRecord(value);
  if (!source || !hasOnlyKeys(source, ["x", "y", "width", "height"])) return null;
  const x = boundedNumber(source.x, { minimum: -1_000_000, maximum: 1_000_000, integer: true });
  const y = boundedNumber(source.y, { minimum: -1_000_000, maximum: 1_000_000, integer: true });
  const width = boundedNumber(source.width, {
    minimum: minimumSize,
    maximum: 100_000,
    integer: true,
  });
  const height = boundedNumber(source.height, {
    minimum: minimumSize,
    maximum: 100_000,
    integer: true,
  });
  return x !== null && y !== null && width !== null && height !== null
    ? { x, y, width, height }
    : null;
}

function parseWindowPlacement(value: unknown): WindowPlacement | null {
  const source = plainRecord(value);
  if (!source || !hasOnlyKeys(source, ["bounds", "displayId", "workArea", "scaleFactor"]))
    return null;
  const bounds = parseStoredRectangle(source.bounds, 100);
  const workArea = parseStoredRectangle(source.workArea, 1);
  const displayId = boundedNumber(source.displayId, {
    minimum: -10,
    maximum: Number.MAX_SAFE_INTEGER,
    integer: true,
  });
  const scaleFactor = boundedNumber(source.scaleFactor, { minimum: 0.1, maximum: 16 });
  return bounds && workArea && displayId !== null && scaleFactor !== null
    ? { bounds, displayId, workArea, scaleFactor }
    : null;
}

function parsePreferenceList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = boundedString(item, 128, 1)?.trim();
    if (!text) return null;
    const key = text.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(text);
    }
  }
  return normalized;
}

function parseNullableSplitValue(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = boundedNumber(value, { minimum: 0, maximum: 1_000_000_000_000_000 });
  return parsed === null ? undefined : parsed;
}

export function parseUserPreferences(value: unknown): UserPreferences | null {
  const source = plainRecord(value);
  if (!source || !hasOnlyKeys(source, ["alerts", "filters"])) return null;
  const alerts = plainRecord(source.alerts);
  const filters = plainRecord(source.filters);
  if (
    !alerts ||
    !filters ||
    !hasOnlyKeys(alerts, [
      "enabled",
      "muted",
      "includeSensitiveDetails",
      "minimumSplitValue",
      "hulls",
      "systems",
      "routes",
      "quietHours",
    ]) ||
    !hasOnlyKeys(filters, ["query", "minimumSplitValue"]) ||
    typeof alerts.enabled !== "boolean" ||
    typeof alerts.muted !== "boolean" ||
    typeof alerts.includeSensitiveDetails !== "boolean"
  )
    return null;

  const minimumSplitValue = parseNullableSplitValue(alerts.minimumSplitValue);
  const filterMinimumSplitValue = parseNullableSplitValue(filters.minimumSplitValue);
  const hulls = parsePreferenceList(alerts.hulls);
  const systems = parsePreferenceList(alerts.systems);
  const routes = parsePreferenceList(alerts.routes);
  const quiet = plainRecord(alerts.quietHours);
  const query = boundedString(filters.query, 256);
  if (
    minimumSplitValue === undefined ||
    filterMinimumSplitValue === undefined ||
    !hulls ||
    !systems ||
    !routes ||
    query === null ||
    !quiet ||
    !hasOnlyKeys(quiet, ["enabled", "startMinute", "endMinute"]) ||
    typeof quiet.enabled !== "boolean"
  )
    return null;
  const startMinute = boundedNumber(quiet.startMinute, {
    minimum: 0,
    maximum: 1_439,
    integer: true,
  });
  const endMinute = boundedNumber(quiet.endMinute, {
    minimum: 0,
    maximum: 1_439,
    integer: true,
  });
  if (startMinute === null || endMinute === null || (quiet.enabled && startMinute === endMinute)) {
    return null;
  }
  return {
    alerts: {
      enabled: alerts.enabled,
      muted: alerts.muted,
      includeSensitiveDetails: alerts.includeSensitiveDetails,
      minimumSplitValue,
      hulls,
      systems,
      routes,
      quietHours: { enabled: quiet.enabled, startMinute, endMinute },
    },
    filters: { query: query.trim(), minimumSplitValue: filterMinimumSplitValue },
  };
}

export function parseUpdateCache(value: unknown): UpdateCache | null {
  const source = plainRecord(value);
  if (!source || !hasOnlyKeys(source, ["checkedAt", "release"])) return null;
  const checkedAt = boundedNumber(source.checkedAt, {
    minimum: 0,
    maximum: VALIDATION_LIMITS.maxTimestamp,
    integer: true,
  });
  if (checkedAt === null) return null;
  if (source.release === null) return { checkedAt, release: null };
  const release = plainRecord(source.release);
  if (!release || !hasOnlyKeys(release, ["version", "title", "notes", "publishedAt", "releaseUrl"]))
    return null;
  const version = boundedString(release.version, 64, 1);
  const title = boundedString(release.title, 256);
  const notes = boundedString(release.notes, 16_384);
  const publishedAt = boundedString(release.publishedAt, 64);
  const releaseUrl = boundedString(release.releaseUrl, VALIDATION_LIMITS.url, 1);
  return version && title !== null && notes !== null && publishedAt !== null && releaseUrl
    ? { checkedAt, release: { version, title, notes, publishedAt, releaseUrl } }
    : null;
}

export function parseSettings(value: unknown): Settings {
  const source = plainRecord(value);
  if (!source) return {};
  const settings: Settings = {};
  const serverUrl =
    source.serverUrl === null ? null : boundedString(source.serverUrl, VALIDATION_LIMITS.url);
  if (serverUrl !== null || source.serverUrl === null) settings.serverUrl = serverUrl;
  const token =
    source.token === null ? null : boundedString(source.token, VALIDATION_LIMITS.token, 1);
  if ("token" in source) settings.token = token;
  for (const key of ["x", "y", "width", "height"] as const) {
    const number = boundedNumber(
      source[key],
      key === "x" || key === "y"
        ? { minimum: -1_000_000, maximum: 1_000_000, integer: true }
        : { minimum: 100, maximum: 10_000, integer: true },
    );
    if (number !== null) settings[key] = number;
  }
  const windowPlacement = parseWindowPlacement(source.windowPlacement);
  if (windowPlacement) settings.windowPlacement = windowPlacement;
  if (source.opacity === 0 || source.opacity === 1 || source.opacity === 2)
    settings.opacity = source.opacity;
  if (typeof source.watchClipboard === "boolean") settings.watchClipboard = source.watchClipboard;
  const preferences = parseUserPreferences(source.preferences);
  if (preferences) settings.preferences = preferences;
  const updateCache = parseUpdateCache(source.updateCache);
  if (updateCache) settings.updateCache = updateCache;
  return settings;
}

export function parseSettingsDocument(value: unknown): Settings | null {
  return plainRecord(value) ? parseSettings(value) : null;
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
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      integer: true,
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
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      integer: true,
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
    minimum: 0,
    maximum: VALIDATION_LIMITS.maxTimestamp,
    integer: true,
  });
  if (id === null || at === null) return null;

  const target: Scan = { id, at };
  for (const key of [
    "scout",
    "hull",
    "system",
    "pilot",
    "scanGate",
    "headGate",
    "ammo",
    "sec",
    "prepped",
    "notes",
    "fitEft",
  ] as const) {
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
  const at =
    source.at === undefined
      ? null
      : boundedNumberLike(source.at, {
          minimum: 0,
          maximum: VALIDATION_LIMITS.maxTimestamp,
          integer: true,
        });
  const by = boundedString(source.by, VALIDATION_LIMITS.label);
  const count = boundedNumber(source.count, {
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
    integer: true,
  });
  const holdMs = boundedNumberLike(source.holdMs, {
    minimum: 0,
    maximum: VALIDATION_LIMITS.maxDurationMs,
    integer: true,
  });
  if (
    scanId === null ||
    (source.at !== undefined && at === null) ||
    by === null ||
    count === null ||
    holdMs === null
  )
    return null;
  const remainingMs =
    source.remainingMs === undefined
      ? null
      : boundedNumberLike(source.remainingMs, {
          minimum: 0,
          maximum: VALIDATION_LIMITS.maxDurationMs,
          integer: true,
        });
  if (source.remainingMs !== undefined && remainingMs === null) return null;
  const bump: BumpEvent = { scanId, by, count, holdMs };
  if (at !== null) bump.at = at;
  if (remainingMs !== null) bump.remainingMs = remainingMs;
  return bump;
}

// The dashboard returns the created bump event from POST /api/viewer/bump.
// Keep that wire response distinct from BumpResult, which is the viewer's
// renderer-facing IPC acknowledgement.
export function parseBumpResponse(value: unknown): BumpEvent | null {
  return parseBumpEvent(value);
}

export function parseBumpClearedEvent(value: unknown): BumpClearedEvent | null {
  const source = plainRecord(value);
  const scanId = source ? boundedString(source.scanId, VALIDATION_LIMITS.id, 1) : null;
  return scanId === null ? null : { scanId };
}

export function parseViewerReplayMetadata(value: unknown): ViewerReplayMetadata | null {
  const replay = plainRecord(value);
  if (
    !replay ||
    !hasOnlyKeys(replay, ["status"]) ||
    (replay.status !== "snapshot" &&
      replay.status !== "resumed" &&
      replay.status !== "cursor-expired")
  )
    return null;
  return { status: replay.status };
}

export function parseHelloEvent(value: unknown): HelloEvent | null {
  const source = plainRecord(value);
  const name = source ? boundedString(source.name, VALIDATION_LIMITS.label, 1) : null;
  if (name === null) return null;

  const result: HelloEvent = { name };
  if (source?.protocolVersion !== undefined) {
    const version = boundedNumber(source.protocolVersion, {
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      integer: true,
    });
    if (version === null) return null;
    result.protocolVersion = version;
  }
  if (source?.capabilities !== undefined) {
    if (
      !Array.isArray(source.capabilities) ||
      source.capabilities.length > VALIDATION_LIMITS.listEntries ||
      !source.capabilities.every(
        (capability) => boundedString(capability, VALIDATION_LIMITS.label, 1) !== null,
      )
    )
      return null;
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
  const missingCapabilities = KNOWN_CAPABILITIES.filter(
    (capability) => !advertised.has(capability),
  );
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
  if (
    !source ||
    !Array.isArray(source.words) ||
    source.words.length === 0 ||
    source.words.length > VALIDATION_LIMITS.vocabularyEntries
  )
    return null;
  const words: string[] = [];
  for (const word of source.words) {
    const parsed = boundedString(word, VALIDATION_LIMITS.vocabularyWord, 1);
    if (parsed === null) return null;
    words.push(parsed);
  }
  const result: Vocabulary = { words };
  if (source.buildNumber !== undefined) {
    const buildNumber = boundedNumber(source.buildNumber, {
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      integer: true,
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

export function parseServerError(value: unknown): {
  error?: string;
  detail?: string;
  message?: string;
} {
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
  if (
    !source ||
    !hasOnlyKeys(source, ["state", "detail", "compatibility", "protocolVersion", "lastEventAt"])
  )
    return null;
  const states: readonly ConnectionState[] = [
    "live",
    "connecting",
    "reconnecting",
    "replaying",
    "stale",
    "offline",
    "error",
    "unpaired",
    "clip",
    "warn",
  ];
  if (!states.includes(source.state as ConnectionState)) return null;
  const detail =
    source.detail === undefined ? undefined : boundedString(source.detail, VALIDATION_LIMITS.label);
  if (detail === null) return null;
  const result: ConnectionStatus = { state: source.state as ConnectionState };
  if (detail !== undefined) result.detail = detail;
  if (source.compatibility !== undefined) {
    const compatibilities: readonly ProtocolCompatibility[] = [
      "fully-compatible",
      "legacy",
      "limited-capability",
      "newer-protocol",
    ];
    if (!compatibilities.includes(source.compatibility as ProtocolCompatibility)) return null;
    result.compatibility = source.compatibility as ProtocolCompatibility;
  }
  if (source.protocolVersion !== undefined) {
    const protocolVersion = boundedNumber(source.protocolVersion, {
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      integer: true,
    });
    if (protocolVersion === null) return null;
    result.protocolVersion = protocolVersion;
  }
  if (source.lastEventAt !== undefined) {
    const lastEventAt = boundedNumber(source.lastEventAt, {
      minimum: 0,
      maximum: VALIDATION_LIMITS.maxTimestamp,
      integer: true,
    });
    if (lastEventAt === null) return null;
    result.lastEventAt = lastEventAt;
  }
  return result;
}

export function parseUserNotice(value: unknown): UserNotice | null {
  const source = plainRecord(value);
  if (!source || !hasOnlyKeys(source, ["level", "message"])) return null;
  if (source.level !== "info" && source.level !== "warn" && source.level !== "error") return null;
  const message = boundedString(source.message, VALIDATION_LIMITS.label, 1);
  return message ? { level: source.level, message } : null;
}

function parseDiagnosticError(value: unknown): DiagnosticError | null {
  const source = plainRecord(value);
  if (!source || !hasOnlyKeys(source, ["at", "code", "message"])) return null;
  const at = boundedNumber(source.at, {
    minimum: 0,
    maximum: VALIDATION_LIMITS.maxTimestamp,
    integer: true,
  });
  const code = boundedString(source.code, 64, 1);
  const message = boundedString(source.message, VALIDATION_LIMITS.label, 1);
  return at !== null && code && message ? { at, code, message } : null;
}

export function parseDiagnosticsSnapshot(value: unknown): DiagnosticsSnapshot | null {
  const source = plainRecord(value);
  if (
    !source ||
    !hasOnlyKeys(source, ["appVersion", "serverOrigin", "connection", "errors", "update"])
  ) {
    return null;
  }
  const appVersion = boundedString(source.appVersion, 64, 1);
  const serverOrigin = boundedString(source.serverOrigin, VALIDATION_LIMITS.url);
  const connection = parseConnectionStatus(source.connection);
  const update = parseUpdateInfo(source.update);
  if (
    !appVersion ||
    serverOrigin === null ||
    !connection ||
    !update ||
    !Array.isArray(source.errors)
  )
    return null;
  if (source.errors.length > 10) return null;
  const errors = source.errors.map(parseDiagnosticError);
  return errors.every((error): error is DiagnosticError => error !== null)
    ? { appVersion, serverOrigin, connection, errors, update }
    : null;
}

export function parseUpdateInfo(value: unknown): UpdateInfo | null {
  const source = plainRecord(value);
  if (
    !source ||
    !hasOnlyKeys(source, [
      "status",
      "currentVersion",
      "latestVersion",
      "title",
      "notes",
      "publishedAt",
      "releaseUrl",
      "checkedAt",
      "error",
    ])
  )
    return null;
  const statuses: readonly UpdateStatus[] = [
    "unknown",
    "checking",
    "up-to-date",
    "available",
    "error",
  ];
  if (!statuses.includes(source.status as UpdateStatus)) return null;
  const currentVersion = boundedString(source.currentVersion, 64, 1);
  if (!currentVersion) return null;
  const result: UpdateInfo = { status: source.status as UpdateStatus, currentVersion };
  const stringFields = {
    latestVersion: 64,
    title: 256,
    notes: 16_384,
    publishedAt: 64,
    releaseUrl: VALIDATION_LIMITS.url,
    error: VALIDATION_LIMITS.label,
  } as const;
  for (const [key, maximum] of Object.entries(stringFields) as Array<
    [keyof typeof stringFields, number]
  >) {
    if (source[key] === undefined) continue;
    const parsed = boundedString(source[key], maximum);
    if (parsed === null) return null;
    result[key] = parsed;
  }
  if (source.checkedAt !== undefined) {
    const checkedAt = boundedNumber(source.checkedAt, {
      minimum: 0,
      maximum: VALIDATION_LIMITS.maxTimestamp,
      integer: true,
    });
    if (checkedAt === null) return null;
    result.checkedAt = checkedAt;
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
    minimum: 0,
    maximum: VALIDATION_LIMITS.maxTimestamp,
    integer: true,
  });
  const lastKind = source.lastKind;
  if (
    sent === null ||
    ignored === null ||
    lastAt === null ||
    (lastKind !== null && lastKind !== "fit" && lastKind !== "cargo")
  )
    return null;
  return { sent, ignored, lastAt, lastKind };
}

export function parseClipboardResult(value: unknown): ClipboardResult | null {
  const source = plainRecord(value);
  if (
    !source ||
    !hasOnlyKeys(source, [
      "on",
      "stats",
      "vocabulary",
      "ignored",
      "sentKind",
      "delivered",
      "error",
    ]) ||
    typeof source.on !== "boolean"
  )
    return null;
  const stats = parseClipboardStats(source.stats);
  if (!stats) return null;
  const result: ClipboardResult = { on: source.on, stats };
  if (source.vocabulary !== undefined) {
    const vocabulary = boundedNumber(source.vocabulary, {
      minimum: 0,
      maximum: VALIDATION_LIMITS.vocabularyEntries,
      integer: true,
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
    const delivered =
      source.delivered === null
        ? null
        : boundedNumber(source.delivered, {
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
            integer: true,
          });
    if (delivered === null && source.delivered !== null) return null;
    result.delivered = delivered;
  }
  if (source.error !== undefined) {
    if (source.error !== null && boundedString(source.error, VALIDATION_LIMITS.label) === null)
      return null;
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
  if (
    !source ||
    !hasOnlyKeys(source, ["paired", "serverUrl", "opacity"]) ||
    typeof source.paired !== "boolean" ||
    boundedString(source.serverUrl, VALIDATION_LIMITS.url) === null ||
    (source.opacity !== 0 && source.opacity !== 1 && source.opacity !== 2)
  )
    return null;
  return { paired: source.paired, serverUrl: source.serverUrl as string, opacity: source.opacity };
}

export function parseClipboardRelayResponse(value: unknown): ClipboardRelayResponse | null {
  const source = plainRecord(value);
  if (!source) return null;
  const delivered = boundedNumber(source.delivered, {
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    integer: true,
  });
  return delivered === null ? null : { delivered };
}

export function parseNoArguments(value: unknown): value is undefined {
  return value === undefined;
}
