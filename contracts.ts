export type ClipboardKind = "fit" | "cargo";
export type OpacityLevel = 0 | 1 | 2;

export interface Settings {
  serverUrl?: string | null;
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

export interface HelloEvent {
  name: string;
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

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNumberLike(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return finiteNumber(number);
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

type ScanStringKey = "scout" | "hull" | "system" | "pilot" | "scanGate" | "headGate" |
  "ammo" | "sec" | "prepped" | "notes" | "fitEft";
type ScanNumberKey = "valueSell" | "valueBuy" | "valueSplit" | "droppableSplit" | "ehp";

function optionalString(source: UnknownRecord, key: ScanStringKey, target: Scan): boolean {
  if (!(key in source) || source[key] === undefined || source[key] === null) return true;
  const value = string(source[key]);
  if (value === null) return false;
  target[key] = value;
  return true;
}

function optionalNumber(source: UnknownRecord, key: ScanNumberKey, target: Scan): boolean {
  if (!(key in source) || source[key] === undefined || source[key] === null) return true;
  const value = finiteNumberLike(source[key]);
  if (value === null) return false;
  target[key] = value;
  return true;
}

export function parseSettings(value: unknown): Settings {
  const source = record(value);
  if (!source) return {};
  const settings: Settings = {};
  if (typeof source.serverUrl === "string" || source.serverUrl === null) settings.serverUrl = source.serverUrl;
  if (typeof source.token === "string" || source.token === null) settings.token = source.token;
  for (const key of ["x", "y", "width", "height"] as const) {
    const number = finiteNumber(source[key]);
    if (number !== null) settings[key] = number;
  }
  if (source.opacity === 0 || source.opacity === 1 || source.opacity === 2) settings.opacity = source.opacity;
  if (typeof source.watchClipboard === "boolean") settings.watchClipboard = source.watchClipboard;
  return settings;
}

export function parsePairRequest(value: unknown): PairRequest | null {
  const source = record(value);
  if (!source) return null;
  const serverUrl = string(source.serverUrl);
  const code = string(source.code);
  return serverUrl !== null && code !== null ? { serverUrl, code } : null;
}

export function parseScanId(value: unknown): string | null {
  return string(value);
}

export function parseOpacity(value: unknown): OpacityLevel {
  const number = Math.min(2, Math.max(0, Math.round(Number(value) || 0)));
  return number as OpacityLevel;
}

export function parseClipWatchRequest(value: unknown): boolean | undefined | null {
  return value === undefined || typeof value === "boolean" ? value : null;
}

function parseFleet(value: unknown): FleetEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: FleetEntry[] = [];
  for (const item of value) {
    const source = record(item);
    if (!source) return null;
    const name = string(source.name);
    const ships = finiteNumberLike(source.ships);
    if (name === null || ships === null) return null;
    entries.push({ name, ships });
  }
  return entries;
}

function parseCargo(value: unknown): CargoEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: CargoEntry[] = [];
  for (const item of value) {
    const source = record(item);
    if (!source) return null;
    const name = string(source.name);
    const qty = finiteNumberLike(source.qty);
    if (name === null || qty === null) return null;
    entries.push({ name, qty });
  }
  return entries;
}

export function parseScan(value: unknown): Scan | null {
  const source = record(value);
  if (!source) return null;
  const id = string(source.id);
  const at = finiteNumberLike(source.at);
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
  const source = record(value);
  if (!source) return null;
  const scanId = string(source.scanId);
  const by = string(source.by);
  const count = finiteNumber(source.count);
  const holdMs = finiteNumberLike(source.holdMs);
  if (scanId === null || by === null || count === null || holdMs === null) return null;
  const remainingMs = source.remainingMs === undefined ? null : finiteNumberLike(source.remainingMs);
  if (source.remainingMs !== undefined && remainingMs === null) return null;
  return remainingMs === null
    ? { scanId, by, count, holdMs }
    : { scanId, by, count, holdMs, remainingMs };
}

export function parseBumpClearedEvent(value: unknown): BumpClearedEvent | null {
  const source = record(value);
  const scanId = source ? string(source.scanId) : null;
  return scanId === null ? null : { scanId };
}

export function parseHelloEvent(value: unknown): HelloEvent | null {
  const source = record(value);
  const name = source ? string(source.name) : null;
  return name === null ? null : { name };
}

export function parseVocabulary(value: unknown): Vocabulary | null {
  const source = record(value);
  if (!source || !Array.isArray(source.words) || source.words.length === 0 ||
      !source.words.every((word) => typeof word === "string")) return null;
  const result: Vocabulary = { words: [...source.words] as string[] };
  if (source.buildNumber !== undefined) {
    const buildNumber = finiteNumber(source.buildNumber);
    if (buildNumber === null) return null;
    result.buildNumber = buildNumber;
  }
  return result;
}

export function parseClaimResponse(value: unknown): ClaimResponse | null {
  const source = record(value);
  const token = source ? string(source.token) : null;
  return token ? { token } : null;
}

export function parseServerError(value: unknown): { error?: string; detail?: string; message?: string } {
  const source = record(value);
  if (!source) return {};
  const result: { error?: string; detail?: string; message?: string } = {};
  if (typeof source.error === "string") result.error = source.error;
  if (typeof source.detail === "string") result.detail = source.detail;
  if (typeof source.message === "string") result.message = source.message;
  return result;
}

export function parseConnectionStatus(value: unknown): ConnectionStatus | null {
  const source = record(value);
  if (!source) return null;
  const states: readonly ConnectionState[] = ["live", "connecting", "reconnecting", "offline", "error", "unpaired", "clip", "warn"];
  if (!states.includes(source.state as ConnectionState)) return null;
  if (source.detail !== undefined && typeof source.detail !== "string") return null;
  return source.detail === undefined
    ? { state: source.state as ConnectionState }
    : { state: source.state as ConnectionState, detail: source.detail };
}

export function parseClipboardStats(value: unknown): ClipboardStats | null {
  const source = record(value);
  if (!source) return null;
  const sent = finiteNumber(source.sent);
  const ignored = finiteNumber(source.ignored);
  const lastAt = finiteNumber(source.lastAt);
  const lastKind = source.lastKind;
  if (sent === null || ignored === null || lastAt === null ||
      (lastKind !== null && lastKind !== "fit" && lastKind !== "cargo")) return null;
  return { sent, ignored, lastAt, lastKind };
}

export function parseClipboardResult(value: unknown): ClipboardResult | null {
  const source = record(value);
  if (!source || typeof source.on !== "boolean") return null;
  const stats = parseClipboardStats(source.stats);
  if (!stats) return null;
  const result: ClipboardResult = { on: source.on, stats };
  if (source.vocabulary !== undefined) {
    const vocabulary = finiteNumber(source.vocabulary);
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
    const delivered = source.delivered === null ? null : finiteNumber(source.delivered);
    if (delivered === null && source.delivered !== null) return null;
    result.delivered = delivered;
  }
  if (source.error !== undefined) {
    if (source.error !== null && typeof source.error !== "string") return null;
    result.error = source.error;
  }
  return result;
}

export function parsePairResult(value: unknown): PairResult | null {
  const source = record(value);
  if (!source || typeof source.ok !== "boolean") return null;
  if (source.ok) return { ok: true };
  return typeof source.error === "string" ? { ok: false, error: source.error } : null;
}

export function parseBumpResult(value: unknown): BumpResult | null {
  return parsePairResult(value);
}

export function parseViewerState(value: unknown): ViewerState | null {
  const source = record(value);
  if (!source || typeof source.paired !== "boolean" || typeof source.serverUrl !== "string" ||
      (source.opacity !== 0 && source.opacity !== 1 && source.opacity !== 2)) return null;
  return { paired: source.paired, serverUrl: source.serverUrl, opacity: source.opacity };
}
