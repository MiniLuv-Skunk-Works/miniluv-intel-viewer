import { classify, plausibleCharacterName } from "./clipboard-filter";
import type { ClipboardCapture, ClipboardKind, ClipboardStats } from "./contracts";
import type { ForegroundApplicationProbe } from "./foreground-application";
import type { PilotNameValidation } from "./pilot-name-validator";

export interface ClipboardWatcherCallbacks {
  onCapture(capture: ClipboardCapture): void;
  onIgnored(needsVocabulary: boolean): void;
}

export interface ClipboardWatcherOptions extends ClipboardWatcherCallbacks {
  readText(): string | Promise<string>;
  foregroundProbe: ForegroundApplicationProbe;
  pilotValidator: PilotNameValidation;
  setInterval?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  pollMs?: number;
  now?: () => number;
}

const DEFAULT_POLL_MS = 500;

export class ClipboardWatcher {
  private readonly readText: () => string | Promise<string>;
  private readonly onCapture: (capture: ClipboardCapture) => void;
  private readonly onIgnored: (needsVocabulary: boolean) => void;
  private readonly foregroundProbe: ForegroundApplicationProbe;
  private readonly pilotValidator: PilotNameValidation;
  private readonly setTimer: (callback: () => void, delay: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly pollMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private lastText: string | null = "";
  private lifecycle = 0;
  private readSequence = 0;
  private baseline: Promise<void> | null = null;
  private vocabulary: ReadonlySet<string> | null = null;
  private generation = 0;
  private detectPilot = false;
  private readonly state: ClipboardStats = { sent: 0, ignored: 0, lastKind: null, lastAt: 0 };

  constructor(options: ClipboardWatcherOptions) {
    this.readText = () => options.readText();
    this.onCapture = (capture) => options.onCapture(capture);
    this.onIgnored = (needsVocabulary) => options.onIgnored(needsVocabulary);
    this.foregroundProbe = options.foregroundProbe;
    this.pilotValidator = options.pilotValidator;
    this.setTimer = options.setInterval ?? setInterval;
    this.clearTimer = options.clearInterval ?? clearInterval;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    const lifecycle = ++this.lifecycle;
    this.lastText = null;
    this.baseline = this.seedBaseline(lifecycle);
    this.timer = this.setTimer(() => {
      void this.poll();
    }, this.pollMs);
  }

  stop(): void {
    this.lifecycle += 1;
    this.readSequence += 1;
    this.baseline = null;
    this.generation += 1;
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  setVocabulary(words: ReadonlySet<string> | null): void {
    this.vocabulary = words;
  }

  vocabularySize(): number {
    return this.vocabulary?.size ?? 0;
  }

  setPilotDetection(enabled: boolean): void {
    if (this.detectPilot === enabled) return;
    this.detectPilot = enabled;
    if (!enabled) this.generation += 1;
  }

  stats(): ClipboardStats {
    return { ...this.state };
  }

  markSent(kind: ClipboardKind): void {
    this.state.sent += 1;
    this.state.lastKind = kind;
    this.state.lastAt = this.now();
  }

  async poll(): Promise<void> {
    const lifecycle = this.lifecycle;
    if (this.baseline) await this.baseline;
    if (lifecycle !== this.lifecycle) return;
    const readSequence = ++this.readSequence;
    // An asynchronous read may finish after focus changes. Require EVE on
    // both sides of the read, and never classify a superseded read result.
    const foregroundBefore = this.foregroundProbe.isEveClientForeground().catch(() => false);
    let text: string;
    try {
      text = await this.readText();
    } catch {
      return;
    }
    if (lifecycle !== this.lifecycle || readSequence !== this.readSequence) return;
    const previousText = this.lastText;
    if (text === previousText) return;
    this.lastText = text;
    const generation = ++this.generation;
    // If the initial read failed, seed from the next successful read rather
    // than relaying text that may have been copied before watching began.
    if (previousText === null || !text) return;

    const wasEveForeground = await foregroundBefore;
    if (generation !== this.generation) return;
    const eveForeground =
      wasEveForeground && (await this.foregroundProbe.isEveClientForeground().catch(() => false));
    if (generation !== this.generation) return;
    if (!eveForeground) {
      this.ignore(false);
      return;
    }

    const capture = classify(text, this.vocabulary);
    if (capture) {
      this.onCapture(capture);
      return;
    }

    if (this.detectPilot) {
      const candidate = plausibleCharacterName(text);
      if (candidate) {
        const canonicalName = await this.pilotValidator.validate(candidate);
        if (generation !== this.generation || !this.detectPilot) return;
        if (canonicalName) {
          this.onCapture({ kind: "pilot", text: canonicalName });
          return;
        }
      }
    }

    this.ignore(this.vocabulary === null);
  }

  private async seedBaseline(lifecycle: number): Promise<void> {
    try {
      const text = await this.readText();
      if (lifecycle === this.lifecycle) this.lastText = text;
    } catch {
      // The next successful poll becomes the baseline.
    }
  }

  private ignore(needsVocabulary: boolean): void {
    this.state.ignored += 1;
    this.onIgnored(needsVocabulary);
  }
}
