import { URL } from "node:url";
import type { ClipboardWatcher, ClipboardWatcherCallbacks } from "./clipboard-watcher";
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
  parseServerError,
  parseVocabulary,
  type BumpResult,
  type ClipboardCapture,
  type ClipboardResult,
  type ConnectionStatus,
  type IpcEventContract,
  type KnownCapability,
  type OpacityLevel,
  type PairRequest,
  type PairResult,
  type ProtocolNegotiation,
  type ViewerState,
  type Vocabulary,
} from "./contracts";
import type { CredentialStore } from "./credentials";
import { DashboardClient, type DashboardRequestFailure } from "./dashboard-client";
import { parseDashboardOrigin, type DashboardOriginResult } from "./dashboard-url";
import {
  FeedConnectionManager,
  type FeedConnectionCallbacks,
  type FeedSession,
  type SseMessage,
} from "./feed-connection";
import type { AtomicJsonFile, SettingsStore } from "./settings-store";

const SMALL_RESPONSE_LIMIT = 64 * 1024;
const VOCABULARY_RESPONSE_LIMIT = 16 * 1024 * 1024;
const VOCABULARY_RESPONSE_TIMEOUT_MS = 60_000;

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
  private protocol: ProtocolNegotiation | null = null;
  private startupPairingDetail: string | null = null;
  private networkGeneration = 0;

  constructor(options: ViewerControllerOptions) {
    this.settingsStore = options.settingsStore;
    this.credentials = options.credentials;
    this.vocabularyFile = options.vocabularyFile;
    this.dashboardClient = options.dashboardClient ?? new DashboardClient();
    this.allowInsecureLocalhost = options.allowInsecureLocalhost;
    this.relay = options.relay;
    this.feedConnection = (
      options.createFeedConnection ?? ((callbacks) => new FeedConnectionManager(callbacks))
    )({
      onStatus: (status) => this.relay("status", status),
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
    this.relay("status", { state: "unpaired" });
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
      this.relay(
        "status",
        this.startupPairingDetail
          ? { state: "unpaired", detail: this.startupPairingDetail }
          : { state: "unpaired" },
      );
      return;
    }
    this.feedConnection.start(auth);
  }

  private replaceNetworkSession(): void {
    this.networkGeneration += 1;
    this.dashboardClient.cancelAll();
    this.feedConnection.stop();
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
      if (!scan || (id !== undefined && id !== scan.id)) return false;
      this.relay("scan", scan);
      return true;
    }
    if (event === "bump") {
      const bump = parseBumpEvent(parsed);
      if (!bump) return false;
      this.relay("bump", bump);
      return true;
    }
    if (event === "bumpCleared") {
      const cleared = parseBumpClearedEvent(parsed);
      if (!cleared) return false;
      this.relay("bumpCleared", cleared);
      return true;
    }
    if (event !== "hello") return false;

    const hello = parseHelloEvent(parsed);
    if (!hello) return false;
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
      status.state = "warn";
      status.detail = "Replay history expired - showing retained scans";
    }
    this.relay("status", status);
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
      return {
        state: "warn",
        detail: "Legacy dashboard - compatibility mode",
        compatibility: negotiated.compatibility,
      };
    }
    if (negotiated.compatibility === "newer-protocol") {
      return {
        state: "warn",
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
    };
    return {
      state: "warn",
      detail:
        "Limited dashboard - " +
        negotiated.missingCapabilities.map((capability) => labels[capability]).join(", ") +
        " unavailable",
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
    this.relay("status", { state: "unpaired", detail: "pairing expired - pair again" });
  }
}
