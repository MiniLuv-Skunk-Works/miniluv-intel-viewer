import { URL } from "node:url";
import type { ClipboardWatcher, ClipboardWatcherCallbacks } from "./clipboard-watcher";
import type { AlertService } from "./alerting";
import {
  PROTOCOL_CAPABILITIES,
  negotiateProtocol,
  parseBumpClearedEvent,
  parseBumpEvent,
  parseBumpResponse,
  parseClaimResponse,
  parseClipboardRelayResponse,
  parseHelloEvent,
  parseScan,
  parseScanRevisionId,
  parseServerError,
  parseVocabulary,
  type BumpResult,
  type ClipboardCapture,
  type ClipboardResult,
  type ConnectionStatus,
  defaultUserPreferences,
  type DiagnosticsSnapshot,
  type IpcEventContract,
  type KnownCapability,
  type OpacityLevel,
  type PairRequest,
  type PairResult,
  type ProtocolNegotiation,
  type ViewerState,
  type UserPreferences,
  type UpdateInfo,
  type Vocabulary,
} from "./contracts";
import type { CredentialStore } from "./credentials";
import { DashboardClient, type DashboardRequestFailure } from "./dashboard-client";
import { parseDashboardOrigin, type DashboardOriginResult } from "./dashboard-url";
import {
  FeedConnectionManager,
  type FeedConnectionCallbacks,
  type FeedConnectionStatus,
  type FeedSession,
  type SseMessage,
} from "./feed-connection";
import type { AtomicJsonFile, SettingsStore } from "./settings-store";
import type { DiagnosticsRecorder } from "./diagnostics";
import type { UpdateChecker } from "./update-checker";

const SMALL_RESPONSE_LIMIT = 64 * 1024;
const VOCABULARY_RESPONSE_LIMIT = 16 * 1024 * 1024;
const VOCABULARY_RESPONSE_TIMEOUT_MS = 60_000;
const MAX_SEEN_STABLE_SCAN_IDS = 1_024;

export type ViewerRelay = <K extends keyof IpcEventContract>(
  channel: K,
  payload: IpcEventContract[K],
) => void;

export interface FeedConnectionLike {
  start(session: FeedSession): void;
  stop(): void;
  setReplayEnabled(enabled: boolean): void;
}

export interface ViewerControllerOptions {
  settingsStore: SettingsStore;
  credentials: CredentialStore;
  vocabularyFile: AtomicJsonFile<Vocabulary>;
  dashboardClient?: DashboardClient;
  allowInsecureLocalhost: boolean;
  relay: ViewerRelay;
  createFeedConnection?: (callbacks: FeedConnectionCallbacks) => FeedConnectionLike;
  createClipboardWatcher: (callbacks: ClipboardWatcherCallbacks) => ClipboardWatcher;
  alertService: AlertService;
  diagnostics: DiagnosticsRecorder;
  updateChecker: UpdateChecker;
  appVersion: string;
}

export class ViewerController {
  private readonly settingsStore: SettingsStore;
  private readonly credentials: CredentialStore;
  private readonly vocabularyFile: AtomicJsonFile<Vocabulary>;
  private readonly dashboardClient: DashboardClient;
  private readonly allowInsecureLocalhost: boolean;
  private readonly relay: ViewerRelay;
  private readonly feedConnection: FeedConnectionLike;
  private readonly clipboardWatcher: ClipboardWatcher;
  private readonly alertService: AlertService;
  private readonly diagnosticsRecorder: DiagnosticsRecorder;
  private readonly updateChecker: UpdateChecker;
  private readonly appVersion: string;
  private protocol: ProtocolNegotiation | null = null;
  private startupPairingDetail: string | null = null;
  private networkGeneration = 0;
  private lastEventAt: number | undefined;
  private connectionStatus: ConnectionStatus = { state: "unpaired" };
  private replayTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly seenStableScanIds = new Set<string>();
  private readonly seenStableScanIdOrder: string[] = [];

  constructor(options: ViewerControllerOptions) {
    this.settingsStore = options.settingsStore;
    this.credentials = options.credentials;
    this.vocabularyFile = options.vocabularyFile;
    this.dashboardClient = options.dashboardClient ?? new DashboardClient();
    this.allowInsecureLocalhost = options.allowInsecureLocalhost;
    this.relay = options.relay;
    this.alertService = options.alertService;
    this.diagnosticsRecorder = options.diagnostics;
    this.updateChecker = options.updateChecker;
    this.appVersion = options.appVersion;
    this.feedConnection = (
      options.createFeedConnection ?? ((callbacks) => new FeedConnectionManager(callbacks))
    )({
      onStatus: (status) => this.handleFeedStatus(status),
      onEvent: (message) => this.handleEvent(message),
      onUnauthorized: () => {
        void this.expirePairing();
      },
    });
    this.clipboardWatcher = options.createClipboardWatcher({
      onCapture: (capture) => this.sendClipboard(capture),
      onIgnored: (needsVocabulary) => {
        if (needsVocabulary) this.fetchVocabulary();
        this.relay("clipwatch", {
          on: true,
          stats: this.clipboardWatcher.stats(),
          ignored: true,
        });
      },
    });
  }

  async initialize(): Promise<void> {
    const settings = await this.settingsStore.initialize();
    this.alertService.configure(settings.preferences?.alerts ?? defaultUserPreferences().alerts);
    const initialized = await this.credentials.initialize(settings.token);
    if (initialized.removeLegacyToken) await this.settingsStore.saveNow({}, ["token"]);

    if (initialized.status === "unavailable") {
      this.startupPairingDetail =
        "Secure credential storage is unavailable - pair again after it is restored.";
    } else if (initialized.status === "corrupt") {
      this.startupPairingDetail = "The stored pairing could not be unlocked - pair again.";
    }

    if (settings.serverUrl) {
      const parsed = this.storedOrigin(settings.serverUrl);
      if (parsed.ok) {
        if (parsed.origin !== settings.serverUrl) {
          await this.settingsStore.saveNow({ serverUrl: parsed.origin }, ["token"]);
        }
      } else if (this.credentials.get()) {
        await this.credentials.clear();
        this.startupPairingDetail =
          "The stored dashboard address is no longer allowed - pair again.";
      }
    } else if (this.credentials.get()) {
      await this.credentials.clear();
      this.startupPairingDetail = "The stored pairing is incomplete - pair again.";
    }

    const cached = await this.vocabularyFile.load();
    if (cached) this.clipboardWatcher.setVocabulary(new Set(cached.words));
  }

  start(): void {
    this.connect();
    this.fetchVocabulary();
    if (this.clipboardWatching()) this.clipboardWatcher.start();
    void this.updateChecker.check(false);
  }

  async pair(request: PairRequest): Promise<PairResult> {
    const parsedOrigin = this.storedOrigin(request.serverUrl);
    if (!parsedOrigin.ok) return { ok: false, error: parsedOrigin.error };
    const result = await this.dashboardClient.requestJson({
      url: new URL("/api/viewer/claim", parsedOrigin.origin),
      method: "POST",
      body: { code: request.code },
      parse: parseClaimResponse,
      maxResponseBytes: SMALL_RESPONSE_LIMIT,
    });
    if (!result.ok) return { ok: false, error: this.requestFailureMessage(result) };
    if (!(await this.credentials.set(result.body.token))) {
      return {
        ok: false,
        error: "Secure credential storage is unavailable. Pair again after it is restored.",
      };
    }

    this.replaceNetworkSession();
    await this.settingsStore.saveNow({ serverUrl: parsedOrigin.origin }, ["token"]);
    this.startupPairingDetail = null;
    this.protocol = null;
    this.clipboardWatcher.setVocabulary(null);
    this.fetchVocabulary();
    this.connect();
    return { ok: true };
  }

  async unpair(): Promise<boolean> {
    this.replaceNetworkSession();
    this.protocol = null;
    this.startupPairingDetail = null;
    await this.credentials.clear();
    await this.settingsStore.saveNow({}, ["token"]);
    this.relay("unpaired", undefined);
    this.emitStatus({ state: "unpaired" });
    return true;
  }

  state(): ViewerState {
    const settings = this.settingsStore.get();
    return {
      paired: !!this.credentials.get(),
      serverUrl: settings.serverUrl || "",
      opacity: settings.opacity ?? 1,
    };
  }

  preferences(): UserPreferences {
    const stored = this.settingsStore.get().preferences;
    return stored
      ? {
          alerts: {
            ...stored.alerts,
            hulls: [...stored.alerts.hulls],
            systems: [...stored.alerts.systems],
            routes: [...stored.alerts.routes],
            quietHours: { ...stored.alerts.quietHours },
          },
          filters: { ...stored.filters },
        }
      : defaultUserPreferences();
  }

  savePreferences(preferences: UserPreferences): UserPreferences {
    this.settingsStore.scheduleSave({ preferences });
    this.alertService.configure(preferences.alerts);
    return this.preferences();
  }

  diagnostics(): DiagnosticsSnapshot {
    const parsed = this.storedOrigin(this.settingsStore.get().serverUrl);
    return this.diagnosticsRecorder.snapshot(
      this.appVersion,
      parsed.ok ? parsed.origin : "",
      this.updateChecker.cachedInfo(),
    );
  }

  checkUpdate(): Promise<UpdateInfo> {
    return this.updateChecker.check(true);
  }

  setOpacity(level: OpacityLevel): OpacityLevel {
    this.settingsStore.scheduleSave({ opacity: level });
    return level;
  }

  async bump(scanId: string): Promise<BumpResult> {
    const auth = this.session();
    if (!auth) return { ok: false, error: "not paired" };
    if (!this.supports(PROTOCOL_CAPABILITIES.bumpControl)) {
      return { ok: false, error: "This dashboard does not advertise bump control." };
    }
    const result = await this.dashboardClient.requestJson({
      url: new URL("/api/viewer/bump", auth.serverUrl),
      method: "POST",
      token: auth.token,
      body: { scanId },
      parse: parseBumpResponse,
      maxResponseBytes: SMALL_RESPONSE_LIMIT,
    });
    if (result.ok) return { ok: true };

    const failure = parseServerError(result.body);
    if (
      result.kind === "http" &&
      result.status === 404 &&
      !failure.detail &&
      /not found/i.test(failure.message || "")
    ) {
      return {
        ok: false,
        error: "This dashboard doesn't support bumping yet - it needs updating.",
      };
    }
    return {
      ok: false,
      error: failure.detail || failure.error || this.requestFailureMessage(result),
    };
  }

  clipboard(on: boolean | undefined): ClipboardResult {
    if (on === undefined) {
      return {
        on: this.clipboardWatching(),
        stats: this.clipboardWatcher.stats(),
        vocabulary: this.clipboardWatcher.vocabularySize(),
      };
    }
    if (
      on &&
      (!this.supports(PROTOCOL_CAPABILITIES.clipboardRelay) ||
        !this.supports(PROTOCOL_CAPABILITIES.clipboardVocabulary))
    ) {
      return {
        on: this.clipboardWatching(),
        stats: this.clipboardWatcher.stats(),
        error: "dashboard does not advertise clipboard support",
      };
    }
    if (on && this.clipboardWatcher.vocabularySize() === 0) this.fetchVocabulary();
    this.setClipboardWatching(on);
    return { on, stats: this.clipboardWatcher.stats() };
  }

  clipboardWatching(): boolean {
    return !!this.settingsStore.get().watchClipboard;
  }

  setClipboardWatching(on: boolean): void {
    this.settingsStore.scheduleSave({ watchClipboard: on });
    if (on) this.clipboardWatcher.start();
    else this.clipboardWatcher.stop();
    this.relay("clipwatch", { on, stats: this.clipboardWatcher.stats() });
  }

  async shutdown(): Promise<void> {
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.updateChecker.cancel();
    this.networkGeneration += 1;
    this.dashboardClient.cancelAll();
    this.feedConnection.stop();
    this.clipboardWatcher.stop();
    await Promise.all([this.settingsStore.flush(), this.vocabularyFile.flush()]);
  }

  private storedOrigin(serverUrl: unknown): DashboardOriginResult {
    return parseDashboardOrigin(serverUrl, this.allowInsecureLocalhost);
  }

  private session(): FeedSession | null {
    const token = this.credentials.get();
    const parsed = this.storedOrigin(this.settingsStore.get().serverUrl);
    return token && parsed.ok ? { serverUrl: parsed.origin, token } : null;
  }

  private supports(capability: KnownCapability): boolean {
    if (!this.protocol || this.protocol.compatibility === "legacy") return true;
    if (this.protocol.compatibility === "newer-protocol") return false;
    return this.protocol.capabilities.includes(capability);
  }

  private connect(): void {
    const auth = this.session();
    if (!auth) {
      this.emitStatus(
        this.startupPairingDetail
          ? { state: "unpaired", detail: this.startupPairingDetail }
          : { state: "unpaired" },
      );
      return;
    }
    this.feedConnection.start(auth);
  }

  private emitStatus(status: ConnectionStatus): void {
    const merged = {
      ...status,
      ...(this.lastEventAt === undefined ? {} : { lastEventAt: this.lastEventAt }),
    };
    this.connectionStatus = merged;
    this.diagnosticsRecorder.setConnection(merged);
    this.relay("status", merged);
  }

  private handleFeedStatus(status: FeedConnectionStatus): void {
    if (status.state === "connecting") {
      this.alertService.setArmed(false);
      this.clearReplayTimer();
      this.emitStatus({ state: "connecting" });
      return;
    }
    if (status.state === "live") {
      this.emitStatus({ state: "live" });
      this.scheduleReplaySettled(false);
      return;
    }
    if (status.state === "stale") {
      this.emitStatus({ state: "stale", detail: "No feed activity for 30 seconds" });
      return;
    }
    this.alertService.setArmed(false);
    this.clearReplayTimer();
    const detail = "detail" in status ? status.detail : "feed unavailable";
    if (/timed out|timeout/i.test(detail)) this.diagnosticsRecorder.record("feed-timeout");
    else if (/invalid|non-SSE|exceeded/i.test(detail))
      this.diagnosticsRecorder.record("feed-invalid");
    else this.diagnosticsRecorder.record("feed-unreachable");
    this.emitStatus({
      state: "offline",
      detail: status.state === "reconnecting" ? `Retrying in ${detail}` : detail,
    });
  }

  private clearReplayTimer(): void {
    if (this.replayTimer) clearTimeout(this.replayTimer);
    this.replayTimer = null;
  }

  private scheduleReplaySettled(showReplaying: boolean): void {
    this.clearReplayTimer();
    this.alertService.setArmed(false);
    if (showReplaying) this.emitStatus({ state: "replaying", detail: "Restoring retained scans" });
    this.replayTimer = setTimeout(() => {
      this.replayTimer = null;
      this.alertService.setArmed(true);
      this.emitStatus({ state: "live" });
    }, 1_000);
  }

  private acceptedEvent(): void {
    this.lastEventAt = Date.now();
    this.emitStatus(this.connectionStatus);
  }

  private replaceNetworkSession(): void {
    this.networkGeneration += 1;
    this.lastEventAt = undefined;
    this.alertService.setArmed(false);
    this.clearReplayTimer();
    this.dashboardClient.cancelAll();
    this.feedConnection.stop();
    this.seenStableScanIds.clear();
    this.seenStableScanIdOrder.length = 0;
  }

  private rememberStableScanId(id: string): boolean {
    if (this.seenStableScanIds.has(id)) return true;
    this.seenStableScanIds.add(id);
    this.seenStableScanIdOrder.push(id);
    if (this.seenStableScanIdOrder.length > MAX_SEEN_STABLE_SCAN_IDS) {
      const oldest = this.seenStableScanIdOrder.shift();
      if (oldest !== undefined) this.seenStableScanIds.delete(oldest);
    }
    return false;
  }

  private requestFailureMessage(result: DashboardRequestFailure): string {
    if (result.kind === "http") {
      const server = parseServerError(result.body);
      return server.detail || server.error || server.message || result.message;
    }
    return result.message;
  }

  private fetchVocabulary(): void {
    if (!this.supports(PROTOCOL_CAPABILITIES.clipboardVocabulary)) return;
    const auth = this.session();
    if (!auth) return;
    const generation = this.networkGeneration;
    void this.dashboardClient
      .requestJson({
        url: new URL("/api/viewer/vocabulary", auth.serverUrl),
        method: "GET",
        token: auth.token,
        parse: parseVocabulary,
        maxResponseBytes: VOCABULARY_RESPONSE_LIMIT,
        responseTimeoutMs: VOCABULARY_RESPONSE_TIMEOUT_MS,
      })
      .then((result) => {
        if (!result.ok || generation !== this.networkGeneration) return;
        this.clipboardWatcher.setVocabulary(new Set(result.body.words));
        void this.vocabularyFile.write(result.body);
        this.relay("clipwatch", {
          on: this.clipboardWatching(),
          stats: this.clipboardWatcher.stats(),
          vocabulary: this.clipboardWatcher.vocabularySize(),
        });
      });
  }

  private sendClipboard(capture: ClipboardCapture): void {
    if (!this.supports(PROTOCOL_CAPABILITIES.clipboardRelay)) {
      this.relay("clipwatch", {
        on: this.clipboardWatching(),
        stats: this.clipboardWatcher.stats(),
        error: "dashboard does not advertise clipboard relay",
      });
      return;
    }
    const auth = this.session();
    if (!auth) return;
    const generation = this.networkGeneration;
    void this.dashboardClient
      .requestJson({
        url: new URL("/api/viewer/clip", auth.serverUrl),
        method: "POST",
        token: auth.token,
        body: capture,
        parse: parseClipboardRelayResponse,
        maxResponseBytes: SMALL_RESPONSE_LIMIT,
      })
      .then((result) => {
        if (generation !== this.networkGeneration || (!result.ok && result.kind === "cancelled")) {
          return;
        }
        if (!result.ok && result.kind !== "http") {
          this.relay("clipwatch", {
            on: true,
            stats: this.clipboardWatcher.stats(),
            error: this.requestFailureMessage(result),
          });
          return;
        }
        this.clipboardWatcher.markSent(capture.kind);
        this.relay("clipwatch", {
          on: true,
          stats: this.clipboardWatcher.stats(),
          sentKind: capture.kind,
          delivered: result.ok ? result.body.delivered : null,
          error: result.ok ? null : this.requestFailureMessage(result),
        });
      });
  }

  private handleEvent({ event, data, id }: SseMessage): boolean {
    if (!data) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return false;
    }
    if (event === "scan") {
      const scan = parseScan(parsed);
      if (!scan || (id !== undefined && parseScanRevisionId(id) === null)) return false;
      const isUpdate = this.rememberStableScanId(scan.id);
      this.acceptedEvent();
      this.relay("scan", scan);
      if (this.connectionStatus.state === "replaying") this.scheduleReplaySettled(true);
      else if (!isUpdate) this.alertService.handle(scan);
      return true;
    }
    if (event === "bump") {
      const bump = parseBumpEvent(parsed);
      if (!bump) return false;
      this.acceptedEvent();
      this.relay("bump", bump);
      return true;
    }
    if (event === "bumpCleared") {
      const cleared = parseBumpClearedEvent(parsed);
      if (!cleared) return false;
      this.acceptedEvent();
      this.relay("bumpCleared", cleared);
      return true;
    }
    if (event !== "hello") return false;

    const hello = parseHelloEvent(parsed);
    if (!hello) return false;
    this.acceptedEvent();
    this.protocol = negotiateProtocol(hello);
    const replaySupported =
      this.protocol.compatibility !== "legacy" &&
      this.protocol.compatibility !== "newer-protocol" &&
      this.protocol.capabilities.includes(PROTOCOL_CAPABILITIES.scanReplay);
    this.feedConnection.setReplayEnabled(replaySupported);
    const clipboardSupported =
      this.supports(PROTOCOL_CAPABILITIES.clipboardRelay) &&
      this.supports(PROTOCOL_CAPABILITIES.clipboardVocabulary);
    if (clipboardSupported) {
      if (this.clipboardWatching()) this.clipboardWatcher.start();
    } else {
      this.clipboardWatcher.stop();
      this.relay("clipwatch", {
        on: false,
        stats: this.clipboardWatcher.stats(),
        error: "dashboard does not advertise clipboard support",
      });
    }
    const status = this.protocolStatus(hello.name, this.protocol);
    if (replaySupported && hello.replay?.status === "cursor-expired") {
      this.relay("notice", {
        level: "warn",
        message: "Replay history expired - showing retained scans",
      });
    }
    this.emitStatus(status);
    if (hello.replay) this.scheduleReplaySettled(true);
    return true;
  }

  private protocolStatus(name: string, negotiated: ProtocolNegotiation): ConnectionStatus {
    if (negotiated.compatibility === "fully-compatible") {
      return {
        state: "live",
        detail: name,
        compatibility: negotiated.compatibility,
        ...(negotiated.protocolVersion === undefined
          ? {}
          : { protocolVersion: negotiated.protocolVersion }),
      };
    }
    if (negotiated.compatibility === "legacy") {
      this.relay("notice", { level: "warn", message: "Legacy dashboard - compatibility mode" });
      return {
        state: "live",
        detail: "Legacy dashboard - compatibility mode",
        compatibility: negotiated.compatibility,
      };
    }
    if (negotiated.compatibility === "newer-protocol") {
      this.relay("notice", {
        level: "warn",
        message: `Dashboard protocol v${negotiated.protocolVersion} is newer - scan feed only`,
      });
      return {
        state: "live",
        detail: `Dashboard protocol v${negotiated.protocolVersion} is newer - scan feed only`,
        compatibility: negotiated.compatibility,
        ...(negotiated.protocolVersion === undefined
          ? {}
          : { protocolVersion: negotiated.protocolVersion }),
      };
    }
    const labels: Record<KnownCapability, string> = {
      "scan-feed": "scan feed",
      "bump-control": "bumping",
      "clipboard-relay": "clipboard relay",
      "clipboard-vocabulary": "clipboard vocabulary",
      "scan-replay": "scan replay",
      "scan-updates": "scan updates",
    };
    const detail =
      "Limited dashboard - " +
      negotiated.missingCapabilities.map((capability) => labels[capability]).join(", ") +
      " unavailable";
    this.relay("notice", { level: "warn", message: detail });
    return {
      state: "live",
      detail,
      compatibility: negotiated.compatibility,
      ...(negotiated.protocolVersion === undefined
        ? {}
        : { protocolVersion: negotiated.protocolVersion }),
    };
  }

  private async expirePairing(): Promise<void> {
    this.networkGeneration += 1;
    this.dashboardClient.cancelAll();
    this.protocol = null;
    await this.credentials.clear();
    this.emitStatus({ state: "unpaired", detail: "pairing expired - pair again" });
  }
}
