import {
  AtomicJsonFile,
  SettingsStore,
  type AtomicFileHandle,
  type AtomicFileSystem,
  type TimerApi,
  type TimerHandle,
} from "../src/settings-store";
import {
  defaultUserPreferences,
  parseSettingsDocument,
  parseVocabulary,
  type Settings,
} from "../src/contracts";
import { test } from "node:test";
import { ok } from "./support/assertions";

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

class MemoryFileSystem implements AtomicFileSystem {
  readonly files = new Map<string, string>();
  readonly events: string[] = [];
  reads = 0;
  failAtomicRename = false;
  failCorruptCopy = false;

  async readFile(file: string, _encoding: "utf8"): Promise<string> {
    this.reads += 1;
    const value = this.files.get(file);
    if (value === undefined) throw codedError("ENOENT");
    return value;
  }

  async mkdir(_directory: string, _options: { recursive: true }): Promise<void> {
    this.events.push("mkdir");
  }

  async open(file: string, _flags: "wx", _mode: number): Promise<AtomicFileHandle> {
    if (this.files.has(file)) throw codedError("EEXIST");
    this.events.push("open");
    this.files.set(file, "");
    return {
      writeFile: async (data) => {
        this.events.push("write");
        this.files.set(file, data);
      },
      sync: async () => {
        this.events.push("sync");
      },
      close: async () => {
        this.events.push("close");
      },
    };
  }

  async copyFile(from: string, to: string, _mode: number): Promise<void> {
    if (this.failCorruptCopy) throw codedError("EACCES");
    if (this.files.has(to)) throw codedError("EEXIST");
    const value = this.files.get(from);
    if (value === undefined) throw codedError("ENOENT");
    this.events.push("preserve");
    this.files.set(to, value);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.failAtomicRename && from.endsWith(".tmp")) throw codedError("EIO");
    const value = this.files.get(from);
    if (value === undefined) throw codedError("ENOENT");
    this.events.push("rename");
    this.files.set(to, value);
    this.files.delete(from);
  }

  async unlink(file: string): Promise<void> {
    this.events.push("unlink");
    if (!this.files.delete(file)) throw codedError("ENOENT");
  }
}

interface FakeTimerHandle extends TimerHandle {
  readonly value: number;
}

class FakeTimers implements TimerApi {
  private nextId = 1;
  private readonly tasks = new Map<number, () => void>();

  set(callback: () => void, _delayMs: number): FakeTimerHandle {
    const value = this.nextId++;
    this.tasks.set(value, callback);
    return { value };
  }

  clear(handle: TimerHandle): void {
    this.tasks.delete(handle.value as number);
  }

  active(): number {
    return this.tasks.size;
  }

  runAll(): void {
    const callbacks = [...this.tasks.values()];
    this.tasks.clear();
    callbacks.forEach((callback) => callback());
  }
}

const fixedNow = () => new Date("2026-08-06T12:34:56.000Z");
const quiet = { onError: () => undefined, now: fixedNow, processId: 42 };

async function run(): Promise<void> {
  console.log("\n=== in-memory settings and debounced persistence ===");
  const file = "C:\\profile\\settings.json";
  const fs = new MemoryFileSystem();
  const timers = new FakeTimers();
  fs.files.set(file, JSON.stringify({ serverUrl: "https://dashboard.example", token: "legacy" }));
  const store = new SettingsStore(file, parseSettingsDocument, {
    ...quiet,
    fileSystem: fs,
    timers,
  });
  await store.initialize();
  store.patch({ opacity: 1 });
  await store.initialize();
  ok("settings are read only once", fs.reads === 1);
  ok(
    "reinitialization cannot discard newer in-memory settings",
    store.get().serverUrl === "https://dashboard.example" && store.get().opacity === 1,
  );

  store.scheduleSave({ x: 1, y: 2, width: 380, height: 460 }, ["token"]);
  store.scheduleSave({ x: 20, y: 30, width: 400, height: 500 });
  ok("rapid changes retain only one debounce timer", timers.active() === 1);
  ok(
    "memory updates immediately while disk waits",
    store.get().x === 20 && JSON.parse(fs.files.get(file)!).x === undefined,
  );
  timers.runAll();
  await store.flush();
  const debounced = JSON.parse(fs.files.get(file)!) as Settings;
  ok(
    "debounced write stores the latest merged settings",
    debounced.x === 20 && debounced.height === 500,
  );
  ok("removed settings do not return", !("token" in debounced));
  ok(
    "atomic order flushes before replacement",
    fs.events.join(",").includes("open,write,sync,close,rename"),
    fs.events.join(","),
  );

  const first = store.saveNow({ opacity: 1 });
  const second = store.saveNow({ opacity: 2 });
  await Promise.all([first, second]);
  ok(
    "serialized writes cannot restore an older snapshot",
    JSON.parse(fs.files.get(file)!).opacity === 2,
  );

  store.scheduleSave({ watchClipboard: true });
  store.scheduleSave({ watchPilotClipboard: true });
  await store.flush();
  ok(
    "flush persists a pending debounce immediately",
    JSON.parse(fs.files.get(file)!).watchClipboard === true &&
      JSON.parse(fs.files.get(file)!).watchPilotClipboard === true &&
      timers.active() === 0,
  );

  console.log("\n=== combat scenario settings migration ===");
  const legacyPreferences = defaultUserPreferences() as unknown as Record<string, unknown>;
  delete legacyPreferences.combatScenario;
  const migrationFs = new MemoryFileSystem();
  migrationFs.files.set(file, JSON.stringify({ preferences: legacyPreferences }));
  const migrated = new SettingsStore(file, parseSettingsDocument, {
    ...quiet,
    fileSystem: migrationFs,
    timers: new FakeTimers(),
  });
  await migrated.initialize();
  ok(
    "older preferences gain defaults without corrupt-file handling",
    migrated.get().preferences?.combatScenario.state === "prepped" &&
      ![...migrationFs.files.keys()].some((name) => name.includes(".corrupt-")),
  );
  await migrated.saveNow({
    preferences: {
      ...migrated.get().preferences!,
      combatScenario: {
        state: "unprepped",
        securityStatus: "0.9",
        tankState: "overheated",
        implant: "nirvana",
      },
    },
  });
  const restarted = new SettingsStore(file, parseSettingsDocument, {
    ...quiet,
    fileSystem: migrationFs,
  });
  await restarted.initialize();
  ok(
    "combat scenario persists across settings-store restarts",
    restarted.get().preferences?.combatScenario.tankState === "overheated" &&
      restarted.get().preferences?.combatScenario.implant === "nirvana",
  );

  console.log("\n=== corrupt and interrupted files ===");
  const corruptFs = new MemoryFileSystem();
  corruptFs.files.set(file, "{truncated");
  const corrupt = new SettingsStore(file, parseSettingsDocument, {
    ...quiet,
    fileSystem: corruptFs,
    timers: new FakeTimers(),
  });
  await corrupt.initialize();
  const diagnostic = [...corruptFs.files.keys()].find((name) => name.includes("settings.corrupt-"));
  ok(
    "malformed settings are preserved under a diagnostic name",
    diagnostic !== undefined &&
      corruptFs.files.get(diagnostic) === "{truncated" &&
      !corruptFs.files.has(file),
  );
  await corrupt.saveNow({ opacity: 1 });
  ok(
    "a fresh valid file can be created after preservation",
    JSON.parse(corruptFs.files.get(file)!).opacity === 1,
  );

  const blockedFs = new MemoryFileSystem();
  blockedFs.files.set(file, "[]");
  blockedFs.failCorruptCopy = true;
  const blocked = new SettingsStore(file, parseSettingsDocument, {
    ...quiet,
    fileSystem: blockedFs,
  });
  await blocked.initialize();
  await blocked.saveNow({ opacity: 2 });
  ok("failed corrupt preservation blocks later overwrite", blockedFs.files.get(file) === "[]");

  const interruptedFs = new MemoryFileSystem();
  interruptedFs.files.set(file, JSON.stringify({ opacity: 1 }));
  const interrupted = new SettingsStore(file, parseSettingsDocument, {
    ...quiet,
    fileSystem: interruptedFs,
  });
  await interrupted.initialize();
  interruptedFs.failAtomicRename = true;
  await interrupted.saveNow({ opacity: 2 });
  ok(
    "a failure before replace retains the last valid settings",
    JSON.parse(interruptedFs.files.get(file)!).opacity === 1,
  );
  ok(
    "failed temporary writes are cleaned up",
    ![...interruptedFs.files.keys()].some((name) => name.endsWith(".tmp")),
  );

  console.log("\n=== vocabulary cache uses the atomic path ===");
  const vocabularyPath = "C:\\profile\\vocabulary.json";
  const vocabularyFs = new MemoryFileSystem();
  vocabularyFs.files.set(vocabularyPath, JSON.stringify({ words: ["tritanium"] }));
  const vocabulary = new AtomicJsonFile(vocabularyPath, parseVocabulary, {
    ...quiet,
    fileSystem: vocabularyFs,
  });
  ok("valid vocabulary cache loads", (await vocabulary.load())?.words[0] === "tritanium");
  vocabularyFs.failAtomicRename = true;
  await vocabulary.write({ words: ["obelisk"] });
  ok(
    "interrupted vocabulary refresh retains the previous cache",
    JSON.parse(vocabularyFs.files.get(vocabularyPath)!).words[0] === "tritanium",
  );
}

test("atomic settings and vocabulary persistence", run);
