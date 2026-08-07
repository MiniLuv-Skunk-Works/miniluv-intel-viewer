import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
  parseClipWatchRequest,
  parseNoArguments,
  parseOpacity,
  parsePairRequest,
  parseScanId,
  parseUserPreferences,
  defaultUserPreferences,
  type BumpResult,
  type ClipboardResult,
  type IpcInvokeContract,
  type OpacityLevel,
  type PairRequest,
  type PairResult,
  type ViewerState,
  type DiagnosticsSnapshot,
  type UpdateInfo,
  type UserPreferences,
} from "./contracts";
import { runAuthorizedIpc } from "./ipc-security";

export interface ViewerActions {
  pair(request: PairRequest): Promise<PairResult>;
  unpair(): Promise<boolean>;
  state(): ViewerState;
  setOpacity(level: OpacityLevel): OpacityLevel;
  bump(scanId: string): Promise<BumpResult>;
  clipboard(on: boolean | undefined): ClipboardResult;
  preferences(): UserPreferences;
  savePreferences(preferences: UserPreferences): UserPreferences;
  diagnostics(): DiagnosticsSnapshot;
  checkUpdate(): Promise<UpdateInfo>;
  openUpdate(): Promise<boolean>;
}

export interface RegisterIpcHandlersOptions {
  ipcMain: IpcMain;
  actions: ViewerActions;
  getWebContents(): WebContents | null;
  quit(): void;
}

type InvokeChannel = keyof IpcInvokeContract;

export function registerIpcHandlers(options: RegisterIpcHandlersOptions): () => void {
  const registered: InvokeChannel[] = [];

  function handle<K extends InvokeChannel>(
    channel: K,
    rejected: () => IpcInvokeContract[K]["result"],
    handler: (
      event: IpcMainInvokeEvent,
      request: unknown,
    ) => IpcInvokeContract[K]["result"] | Promise<IpcInvokeContract[K]["result"]>,
  ): void {
    options.ipcMain.handle(channel, async (event, request: unknown) =>
      runAuthorizedIpc(event, options.getWebContents(), rejected, () => handler(event, request)),
    );
    registered.push(channel);
  }

  handle(
    "pair",
    () => ({ ok: false, error: "Request rejected." }),
    (_event, input) => {
      const request = parsePairRequest(input);
      return request
        ? options.actions.pair(request)
        : { ok: false, error: "Both server address and pairing code are required." };
    },
  );

  handle(
    "unpair",
    () => false,
    (_event, input) => (parseNoArguments(input) ? options.actions.unpair() : false),
  );

  handle(
    "state",
    () => ({ paired: false, serverUrl: "", opacity: 1 }),
    (_event, input) =>
      parseNoArguments(input)
        ? options.actions.state()
        : { paired: false, serverUrl: "", opacity: 1 },
  );

  handle(
    "opacity",
    () => 1,
    (_event, input) => {
      const level = parseOpacity(input);
      return level === null ? options.actions.state().opacity : options.actions.setOpacity(level);
    },
  );

  handle(
    "bump",
    () => ({ ok: false, error: "Request rejected." }),
    (_event, input) => {
      const scanId = parseScanId(input);
      return scanId === null ? { ok: false, error: "invalid scan" } : options.actions.bump(scanId);
    },
  );

  handle(
    "clipwatch",
    () => ({
      on: false,
      stats: { sent: 0, ignored: 0, lastKind: null, lastAt: 0 },
      error: "Request rejected.",
    }),
    (_event, input) => {
      const on = parseClipWatchRequest(input);
      return on === null
        ? { ...options.actions.clipboard(undefined), error: "invalid clipboard setting" }
        : options.actions.clipboard(on);
    },
  );

  handle(
    "preferences",
    () => defaultUserPreferences(),
    (_event, input) =>
      parseNoArguments(input) ? options.actions.preferences() : defaultUserPreferences(),
  );

  handle(
    "savePreferences",
    () => defaultUserPreferences(),
    (_event, input) => {
      const preferences = parseUserPreferences(input);
      return preferences
        ? options.actions.savePreferences(preferences)
        : options.actions.preferences();
    },
  );

  handle(
    "diagnostics",
    () => ({
      appVersion: "unknown",
      serverOrigin: "",
      connection: { state: "offline" },
      errors: [],
      update: { status: "unknown", currentVersion: "unknown" },
    }),
    (_event, input) =>
      parseNoArguments(input)
        ? options.actions.diagnostics()
        : {
            appVersion: "unknown",
            serverOrigin: "",
            connection: { state: "offline" },
            errors: [],
            update: { status: "unknown", currentVersion: "unknown" },
          },
  );

  handle(
    "checkUpdate",
    () => ({ status: "error", currentVersion: "unknown", error: "Request rejected." }),
    (_event, input) =>
      parseNoArguments(input)
        ? options.actions.checkUpdate()
        : { status: "error", currentVersion: "unknown", error: "Invalid update request." },
  );

  handle(
    "openUpdate",
    () => false,
    (_event, input) => (parseNoArguments(input) ? options.actions.openUpdate() : false),
  );

  handle(
    "close",
    () => undefined,
    (_event, input) => {
      if (parseNoArguments(input)) options.quit();
    },
  );

  return () => {
    for (const channel of registered) options.ipcMain.removeHandler(channel);
  };
}
