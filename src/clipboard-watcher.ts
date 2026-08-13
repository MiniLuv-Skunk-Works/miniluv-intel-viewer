import { classify, plausibleCharacterName } from "./clipboard-filter";
import type { ClipboardCapture, ClipboardKind, ClipboardStats } from "./contracts";
import type { ForegroundApplicationProbe } from "./foreground-application";
import type { PilotNameValidation } from "./pilot-name-validator";

export interface ClipboardWatcherCallbacks {
  onCapture(capture: ClipboardCapture): void;
  onIgnored(needsVocabulary: boolean): void;
}

export interface ClipboardWatcherOptions extends ClipboardWatcherCallbacks {
  readText(): string;
  foregroundProbe: ForegroundApplicationProbe;
  pilotValidator: PilotNameValidation;
  setInterval?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  pollMs?: number;
  now?: () => number;
}

const DEFAULT_POLL_MS = 500;

export class ClipboardWatcher {
  private readonly readText: () => string;
  private readonly onCapture: (capture: ClipboardCapture) => void;
  private readonly onIgnored: (needsVocabulary: boolean) => void;
  private readonly foregroundProbe: ForegroundApplicationProbe;
  private readonly pilotValidator: PilotNameValidation;
  private readonly setTimer: (callback: () => void, delay: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly pollMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private lastText = "";
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
    try {
      this.lastText = this.readText();
    } catch {
      this.lastText = "";
    }
    this.timer = this.setTimer(() => {
      void this.poll();
    }, this.pollMs);
  }

  stop(): void {
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
    let text: string;
    try {
      text = this.readText();
    } catch {
      return;
    }
    if (!text || text === this.lastText) return;
    this.lastText = text;
    const generation = ++this.generation;

    // Polling leaves a narrow race if focus changes between clipboard mutation
    // and this snapshot. Capture the text first and bind exactly one foreground
    // result to this immutable generation; never reconsider a rejected value.
    const eveForeground = await this.foregroundProbe.isEveClientForeground().catch(() => false);
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

  private ignore(needsVocabulary: boolean): void {
    this.state.ignored += 1;
    this.onIgnored(needsVocabulary);
  }
}
