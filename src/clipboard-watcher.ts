import { classify } from "./clipboard-filter";
import type { ClipboardCapture, ClipboardKind, ClipboardStats } from "./contracts";

export interface ClipboardWatcherCallbacks {
  onCapture(capture: ClipboardCapture): void;
  onIgnored(needsVocabulary: boolean): void;
}

export interface ClipboardWatcherOptions extends ClipboardWatcherCallbacks {
  readText(): string;
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
  private readonly setTimer: (callback: () => void, delay: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly pollMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private lastText = "";
  private vocabulary: ReadonlySet<string> | null = null;
  private readonly state: ClipboardStats = { sent: 0, ignored: 0, lastKind: null, lastAt: 0 };

  constructor(options: ClipboardWatcherOptions) {
    this.readText = () => options.readText();
    this.onCapture = (capture) => options.onCapture(capture);
    this.onIgnored = (needsVocabulary) => options.onIgnored(needsVocabulary);
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
    this.timer = this.setTimer(() => this.poll(), this.pollMs);
  }

  stop(): void {
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

  stats(): ClipboardStats {
    return { ...this.state };
  }

  markSent(kind: ClipboardKind): void {
    this.state.sent += 1;
    this.state.lastKind = kind;
    this.state.lastAt = this.now();
  }

  poll(): void {
    let text: string;
    try {
      text = this.readText();
    } catch {
      return;
    }
    if (!text || text === this.lastText) return;
    this.lastText = text;

    const capture = classify(text, this.vocabulary);
    if (capture) {
      this.onCapture(capture);
      return;
    }

    this.state.ignored += 1;
    this.onIgnored(this.vocabulary === null);
  }
}
