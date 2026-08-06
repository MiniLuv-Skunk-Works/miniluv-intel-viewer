import { BrowserWindow, Menu, Tray, screen, type Rectangle, type WebContents } from "electron";
import * as path from "node:path";
import type { IpcEventContract } from "./contracts";
import type { SettingsStore } from "./settings-store";
import {
  captureWindowPlacement,
  legacyBounds,
  resetWindowBounds,
  restoreWindowBounds,
  type DisplayGeometry,
} from "./window-placement";

export interface NativeActions {
  quit(): void;
  clipboardWatching(): boolean;
  setClipboardWatching(on: boolean): void;
}

export interface WindowManagerOptions {
  settingsStore: SettingsStore;
  rendererDirectory: string;
  compiledDirectory: string;
  actions: NativeActions;
  onError?: (message: string, error: unknown) => void;
}

export class WindowManager {
  private readonly settingsStore: SettingsStore;
  private readonly rendererDirectory: string;
  private readonly compiledDirectory: string;
  private readonly actions: NativeActions;
  private readonly onError: (message: string, error: unknown) => void;
  private window: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private quitting = false;
  private readonly recover = (): void => this.recoverBounds();
  private readonly recoverMetrics = (
    _event: Electron.Event,
    _display: Electron.Display,
    metrics: string[],
  ): void => {
    if (
      metrics.some(
        (metric) => metric === "bounds" || metric === "workArea" || metric === "scaleFactor",
      )
    ) {
      this.recoverBounds();
    }
  };

  constructor(options: WindowManagerOptions) {
    this.settingsStore = options.settingsStore;
    this.rendererDirectory = options.rendererDirectory;
    this.compiledDirectory = options.compiledDirectory;
    this.actions = options.actions;
    this.onError = options.onError ?? ((message, error) => console.error(message, error));
  }

  create(): void {
    const settings = this.settingsStore.get();
    const displays = this.attachedDisplays();
    const bounds = restoreWindowBounds(
      settings.windowPlacement ?? null,
      legacyBounds(settings),
      displays,
      this.primaryDisplayId(),
    );

    this.window = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      minWidth: 280,
      minHeight: 200,
      icon: path.join(this.rendererDirectory, "icon-256.png"),
      webPreferences: {
        preload: path.join(this.compiledDirectory, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });

    this.window.setAlwaysOnTop(true, "screen-saver");
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    void this.window.loadFile(path.join(this.rendererDirectory, "index.html"));
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.window.webContents.on("will-navigate", (event) => event.preventDefault());
    this.window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    this.window.on("moved", () => this.rememberBounds());
    this.window.on("resized", () => this.rememberBounds());
    this.window.on("closed", () => {
      this.window = null;
      if (!this.quitting) this.actions.quit();
    });
    this.rememberBounds();

    screen.on("display-removed", this.recover);
    screen.on("display-added", this.recover);
    screen.on("display-metrics-changed", this.recoverMetrics);
    this.createTray();
  }

  relay<K extends keyof IpcEventContract>(channel: K, payload: IpcEventContract[K]): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, payload);
  }

  getWebContents(): WebContents | null {
    return this.window && !this.window.isDestroyed() ? this.window.webContents : null;
  }

  show(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.show();
    this.window.focus();
  }

  beginShutdown(): void {
    this.rememberBounds();
    this.quitting = true;
    screen.removeListener("display-removed", this.recover);
    screen.removeListener("display-added", this.recover);
    screen.removeListener("display-metrics-changed", this.recoverMetrics);
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  private attachedDisplays(): DisplayGeometry[] {
    return screen.getAllDisplays().map((display) => ({
      id: display.id,
      workArea: { ...display.workArea },
      scaleFactor: display.scaleFactor,
    }));
  }

  private primaryDisplayId(): number {
    return screen.getPrimaryDisplay().id;
  }

  private sameBounds(left: Rectangle, right: Rectangle): boolean {
    return (
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height
    );
  }

  private rememberBounds(): void {
    if (this.quitting || !this.window || this.window.isDestroyed()) return;
    const placement = captureWindowPlacement(
      this.window.getBounds(),
      this.attachedDisplays(),
      this.primaryDisplayId(),
    );
    this.settingsStore.scheduleSave({ windowPlacement: placement }, ["x", "y", "width", "height"]);
  }

  private recoverBounds(): void {
    if (this.quitting || !this.window || this.window.isDestroyed()) return;
    const displays = this.attachedDisplays();
    const settings = this.settingsStore.get();
    const bounds = restoreWindowBounds(
      settings.windowPlacement ?? null,
      legacyBounds(settings),
      displays,
      this.primaryDisplayId(),
    );
    if (!this.sameBounds(this.window.getBounds(), bounds)) this.window.setBounds(bounds);
    this.rememberBounds();
  }

  private resetPosition(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const bounds = resetWindowBounds(
      this.window.getBounds(),
      this.attachedDisplays(),
      this.primaryDisplayId(),
    );
    this.window.setBounds(bounds);
    this.rememberBounds();
    this.window.show();
  }

  private createTray(): void {
    try {
      this.tray = new Tray(path.join(this.rendererDirectory, "icon.png"));
    } catch (error) {
      this.onError("tray icon missing:", error);
      return;
    }
    this.tray.setToolTip("MILF Viewer");
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show", click: () => this.show() },
        { label: "Clear feed", click: () => this.relay("clear", undefined) },
        {
          label: "Watch clipboard",
          type: "checkbox",
          checked: this.actions.clipboardWatching(),
          click: (item) => this.actions.setClipboardWatching(item.checked),
        },
        { type: "separator" },
        { label: "Re-pair…", click: () => this.relay("repair", undefined) },
        { label: "Reset position", click: () => this.resetPosition() },
        { type: "separator" },
        { label: "Quit", click: () => this.actions.quit() },
      ]),
    );
    this.tray.on("click", () => this.show());
  }
}
