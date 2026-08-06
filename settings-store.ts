import * as nodeFs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import type { Settings } from "./contracts";

export interface AtomicFileHandle {
  writeFile(data: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicFileSystem {
  readFile(file: string, encoding: "utf8"): Promise<string>;
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  open(file: string, flags: "wx", mode: number): Promise<AtomicFileHandle>;
  copyFile(from: string, to: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

export interface TimerHandle {
  readonly value: unknown;
}

export interface TimerApi {
  set(callback: () => void, delayMs: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

export interface AtomicJsonFileOptions {
  fileSystem?: AtomicFileSystem;
  now?: () => Date;
  processId?: number;
  onError?: (message: string, error: unknown) => void;
}

const NODE_FILE_SYSTEM: AtomicFileSystem = {
  readFile: (file, encoding) => nodeFs.readFile(file, encoding),
  mkdir: (directory, options) => nodeFs.mkdir(directory, options),
  open: async (file, flags, mode) => nodeFs.open(file, flags, mode),
  copyFile: (from, to, mode) => nodeFs.copyFile(from, to, mode),
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (file) => nodeFs.unlink(file),
};

const NODE_TIMERS: TimerApi = {
  set(callback, delayMs) {
    return { value: setTimeout(callback, delayMs) };
  },
  clear(handle) {
    clearTimeout(handle.value as NodeJS.Timeout);
  },
};

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export class AtomicJsonFile<T> {
  private readonly fileSystem: AtomicFileSystem;
  private readonly now: () => Date;
  private readonly processId: number;
  private readonly onError: (message: string, error: unknown) => void;
  private readonly validate: (value: unknown) => T | null;
  private readonly file: string;
  private writeSequence = 0;
  private queue: Promise<boolean> = Promise.resolve(true);
  private writable = true;
  private loaded = false;
  private loadedValue: T | null = null;

  constructor(file: string, validate: (value: unknown) => T | null, options: AtomicJsonFileOptions = {}) {
    this.file = file;
    this.validate = validate;
    this.fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM;
    this.now = options.now ?? (() => new Date());
    this.processId = options.processId ?? process.pid;
    this.onError = options.onError ?? ((message, error) => console.error(message, error));
  }

  async load(): Promise<T | null> {
    if (this.loaded) return this.loadedValue;
    this.loaded = true;
    let source: string;
    try {
      source = await this.fileSystem.readFile(this.file, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") this.onError(`read failed for ${this.file}:`, error);
      return null;
    }

    try {
      const parsed = this.validate(JSON.parse(source));
      if (parsed !== null) {
        this.loadedValue = parsed;
        return parsed;
      }
    } catch {
      // The original bytes are preserved below before defaults may be saved.
    }

    await this.preserveCorruptFile();
    return null;
  }

  write(value: T): Promise<boolean> {
    const serialized = JSON.stringify(value, null, 2);
    const next = this.queue.then(() => this.writeAtomic(serialized), () => this.writeAtomic(serialized));
    this.queue = next;
    return next;
  }

  async flush(): Promise<boolean> {
    return this.queue;
  }

  private async preserveCorruptFile(): Promise<void> {
    const extension = path.extname(this.file);
    const base = this.file.slice(0, this.file.length - extension.length);
    const stamp = safeTimestamp(this.now());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${attempt}`;
      const diagnostic = `${base}.corrupt-${stamp}${suffix}${extension}`;
      try {
        await this.fileSystem.copyFile(this.file, diagnostic, fsConstants.COPYFILE_EXCL);
        try { await this.fileSystem.unlink(this.file); } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            this.onError(`could not remove corrupt source ${this.file}:`, error);
          }
        }
        return;
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        this.writable = false;
        this.onError(`could not preserve corrupt file ${this.file}:`, error);
        return;
      }
    }
    this.writable = false;
    this.onError(`could not choose a diagnostic name for ${this.file}:`, new Error("too many collisions"));
  }

  private async writeAtomic(serialized: string): Promise<boolean> {
    if (!this.writable) return false;
    try {
      await this.fileSystem.mkdir(path.dirname(this.file), { recursive: true });
    } catch (error) {
      this.onError(`directory creation failed for ${this.file}:`, error);
      return false;
    }

    let temporary = "";
    let handle: AtomicFileHandle | null = null;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        this.writeSequence += 1;
        temporary = path.join(
          path.dirname(this.file),
          `.${path.basename(this.file)}.${this.processId}.${this.writeSequence}.tmp`,
        );
        try {
          handle = await this.fileSystem.open(temporary, "wx", 0o600);
          break;
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
      }
      if (!handle) throw new Error("could not create a unique temporary file");
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.fileSystem.rename(temporary, this.file);
      this.loadedValue = this.validate(JSON.parse(serialized));
      return true;
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch { /* preserve the original error */ }
      }
      if (temporary) {
        try { await this.fileSystem.unlink(temporary); } catch { /* stale temp is harmless */ }
      }
      this.onError(`atomic write failed for ${this.file}:`, error);
      return false;
    }
  }
}

export interface SettingsStoreOptions extends AtomicJsonFileOptions {
  timers?: TimerApi;
  debounceMs?: number;
}

export class SettingsStore {
  private readonly file: AtomicJsonFile<Settings>;
  private readonly timers: TimerApi;
  private readonly debounceMs: number;
  private state: Settings = {};
  private revision = 0;
  private persistedRevision = 0;
  private timer: TimerHandle | null = null;
  private flushing: Promise<boolean> | null = null;
  private initialized = false;

  constructor(pathname: string, validate: (value: unknown) => Settings | null, options: SettingsStoreOptions = {}) {
    this.file = new AtomicJsonFile(pathname, validate, options);
    this.timers = options.timers ?? NODE_TIMERS;
    this.debounceMs = options.debounceMs ?? 250;
  }

  async initialize(): Promise<Settings> {
    if (this.initialized) return this.get();
    this.initialized = true;
    this.state = await this.file.load() ?? {};
    return this.get();
  }

  get(): Settings {
    return this.state;
  }

  patch(patch: Partial<Settings>, remove: readonly (keyof Settings)[] = []): Settings {
    this.state = { ...this.state, ...patch };
    for (const key of remove) delete this.state[key];
    this.revision += 1;
    return this.state;
  }

  scheduleSave(patch: Partial<Settings>, remove: readonly (keyof Settings)[] = []): Settings {
    const state = this.patch(patch, remove);
    if (this.timer) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    return state;
  }

  async saveNow(patch: Partial<Settings>, remove: readonly (keyof Settings)[] = []): Promise<Settings> {
    this.patch(patch, remove);
    await this.flush();
    return this.state;
  }

  flush(): Promise<boolean> {
    if (this.timer) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    const previous = this.flushing ?? Promise.resolve(true);
    const current = previous.then(() => this.flushRevisions(), () => this.flushRevisions());
    const tracked = current.finally(() => {
      if (this.flushing === tracked) this.flushing = null;
    });
    this.flushing = tracked;
    return tracked;
  }

  private async flushRevisions(): Promise<boolean> {
    while (this.persistedRevision < this.revision) {
      const revision = this.revision;
      const snapshot = this.state;
      if (!await this.file.write(snapshot)) return false;
      this.persistedRevision = revision;
    }
    return this.file.flush();
  }
}
