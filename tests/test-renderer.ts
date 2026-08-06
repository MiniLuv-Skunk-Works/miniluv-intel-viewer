import * as fs from "node:fs";
import * as path from "node:path";
import { Window } from "happy-dom";
import { test } from "node:test";
import type {
  BumpClearedEvent,
  BumpEvent,
  ClipboardResult,
  ConnectionStatus,
  OpacityLevel,
  PairResult,
  Scan,
  ViewerApi,
  ViewerState,
} from "../contracts";
import { startRenderer, type RendererRuntime } from "../renderer/controller";
import { ok } from "./support/assertions";

const ROOT = path.resolve(__dirname, "..", "..");
const html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
const source = fs.readFileSync(path.join(ROOT, "renderer", "controller.ts"), "utf8");

const emptyClipboard = (): ClipboardResult => ({
  on: false,
  stats: { sent: 0, ignored: 0, lastKind: null, lastAt: 0 },
});

class FakeApi implements ViewerApi {
  stateValue: ViewerState = { paired: true, serverUrl: "https://dashboard.example", opacity: 1 };
  pairResult: PairResult = { ok: true };
  bumpCalls: string[] = [];
  pairCalls: Array<[string, string]> = [];
  opacityCalls: number[] = [];
  private scanListener: (scan: Scan) => void = () => undefined;
  private statusListener: (status: ConnectionStatus) => void = () => undefined;
  private clearListener: () => void = () => undefined;
  private repairListener: () => void = () => undefined;
  private bumpListener: (bump: BumpEvent) => void = () => undefined;
  private bumpClearedListener: (event: BumpClearedEvent) => void = () => undefined;
  private clipListener: (result: ClipboardResult) => void = () => undefined;
  private unpairedListener: () => void = () => undefined;

  pair(serverUrl: string, code: string): Promise<PairResult> {
    this.pairCalls.push([serverUrl, code]);
    return Promise.resolve(this.pairResult);
  }
  unpair(): Promise<boolean> {
    return Promise.resolve(true);
  }
  state(): Promise<ViewerState> {
    return Promise.resolve(this.stateValue);
  }
  setOpacity(level: number): Promise<OpacityLevel> {
    this.opacityCalls.push(level);
    return Promise.resolve(level === 0 || level === 2 ? level : 1);
  }
  bump(scanId: string): Promise<{ ok: true }> {
    this.bumpCalls.push(scanId);
    return Promise.resolve({ ok: true });
  }
  clipwatch(): Promise<ClipboardResult> {
    return Promise.resolve(emptyClipboard());
  }
  quit(): Promise<void> {
    return Promise.resolve();
  }
  onScan(listener: (scan: Scan) => void): void {
    this.scanListener = listener;
  }
  onStatus(listener: (status: ConnectionStatus) => void): void {
    this.statusListener = listener;
  }
  onClear(listener: () => void): void {
    this.clearListener = listener;
  }
  onRepair(listener: () => void): void {
    this.repairListener = listener;
  }
  onBump(listener: (bump: BumpEvent) => void): void {
    this.bumpListener = listener;
  }
  onBumpCleared(listener: (event: BumpClearedEvent) => void): void {
    this.bumpClearedListener = listener;
  }
  onClipWatch(listener: (result: ClipboardResult) => void): void {
    this.clipListener = listener;
  }
  onUnpaired(listener: () => void): void {
    this.unpairedListener = listener;
  }
  emitScan(scan: Scan): void {
    this.scanListener(scan);
  }
  emitStatus(status: ConnectionStatus): void {
    this.statusListener(status);
  }
  emitClear(): void {
    this.clearListener();
  }
  emitRepair(): void {
    this.repairListener();
  }
  emitBump(bump: BumpEvent): void {
    this.bumpListener(bump);
  }
  emitBumpCleared(event: BumpClearedEvent): void {
    this.bumpClearedListener(event);
  }
  emitClip(result: ClipboardResult): void {
    this.clipListener(result);
  }
  emitUnpaired(): void {
    this.unpairedListener();
  }
}

class FakeRuntime implements RendererRuntime {
  wallNow = 1_000_000;
  monoNow = 10_000;
  intervals: Array<() => void> = [];
  timeouts: Array<() => void> = [];
  dateNow(): number {
    return this.wallNow;
  }
  monotonicNow(): number {
    return this.monoNow;
  }
  setInterval(callback: () => void): number {
    this.intervals.push(callback);
    return this.intervals.length;
  }
  clearInterval(): void {
    /* retained for deterministic inspection */
  }
  setTimeout(callback: () => void): number {
    this.timeouts.push(callback);
    return this.timeouts.length;
  }
  clearTimeout(): void {
    /* retained for deterministic inspection */
  }
}

const window = new Window({ url: "file:///renderer/index.html" });
// happy-dom deliberately ships its own DOM declarations. The implementation
// is Web-compatible at runtime; cross the type boundary once at the fixture.
const document = window.document as unknown as Document;
document.write(html.replace(/<script[\s\S]*?<\/script>/, ""));
document.close();
const api = new FakeApi();
const runtime = new FakeRuntime();
const cleanup = startRenderer(api, document, runtime);
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function key(target: EventTarget, value: string, shiftKey = false): void {
  const event = new window.KeyboardEvent("keydown", {
    key: value,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event as unknown as Event);
}
function scan(id: string, hull: string): Scan {
  return { id, at: runtime.wallNow - 2000, hull, pilot: "Pilot", scout: "Scout", system: "Uedama" };
}
function articleFor(hull: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>(".scan")).find(
      (node) => node.querySelector(".hull")?.textContent === hull,
    ) ?? null
  );
}

async function run(): Promise<void> {
  await flush();
  console.log("\n=== selector-safe IDs and exact bump ownership ===");
  const hostileIds = [
    `quote"'bracket[]`,
    `back\\slash and whitespace`,
    `Unicode-π-🚀`,
    `#scan > .other:not([safe])`,
  ];
  hostileIds.forEach((id, index) => api.emitScan(scan(id, "Hull " + index)));
  ok("every hostile ID renders", document.querySelectorAll(".scan").length === hostileIds.length);
  const targetId = hostileIds[3] ?? "";
  const target = articleFor("Hull 3");
  const other = articleFor("Hull 2");
  target?.querySelector<HTMLButtonElement>(".bumpbtn")?.click();
  await flush();
  ok("bump closure preserves the exact ID", api.bumpCalls[0] === targetId, api.bumpCalls[0]);
  api.emitBump({ scanId: targetId, by: "Bumper", count: 2, holdMs: 180000, remainingMs: 90000 });
  ok(
    "only the matching timer becomes visible",
    target?.querySelector<HTMLElement>(".bumprow")?.hidden === false &&
      other?.querySelector<HTMLElement>(".bumprow")?.hidden === true,
  );
  api.emitBumpCleared({ scanId: targetId });
  ok(
    "clearing uses the exact mapped timer",
    target?.querySelector<HTMLElement>(".bumprow")?.hidden === true,
  );
  ok(
    "server IDs never become selectors or DOM IDs",
    !source.includes("CSS.escape") && !source.includes("data-bump") && !source.includes("data-id"),
  );

  console.log("\n=== hostile values remain text ===");
  const payload = `"><img src=x onerror=ATTACK()><script>ATTACK()</script>`;
  api.emitScan({
    id: "hostile-text",
    at: runtime.wallNow,
    scout: payload,
    hull: payload,
    system: payload,
    pilot: payload,
    scanGate: payload,
    headGate: payload,
    ammo: payload,
    sec: payload,
    prepped: payload,
    notes: payload,
    fitEft: payload,
    valueSell: 3_000_000_000,
    valueBuy: 2_000_000_000,
    valueSplit: 1_000_000_000,
    droppableSplit: 500_000_000,
    ehp: 900_000,
    fleetAll: [{ name: payload, ships: 12 }],
    cargoList: [{ name: payload, qty: 3 }],
  });
  const hostileArticle = articleFor(payload);
  const hostileOpen = hostileArticle?.querySelector<HTMLElement>(".scanOpen");
  hostileOpen?.click();
  const detail = document.getElementById("detail");
  ok(
    "payload is readable in the scan and detail",
    hostileArticle?.textContent?.includes(payload) &&
      document.getElementById("detailBody")?.textContent?.includes(payload),
  );
  ok(
    "payload creates no foreign elements",
    !hostileArticle?.querySelector("img,script") && !detail?.querySelector("img,script"),
  );
  ok(
    "renderer has no HTML parsing sink",
    !source.includes("innerHTML") &&
      source.includes("textContent") &&
      source.includes("replaceChildren"),
  );

  console.log("\n=== keyboard detail flow and focus containment ===");
  key(document, "Escape");
  hostileOpen?.focus();
  key(hostileOpen ?? document, "Enter");
  ok(
    "Enter opens detail and focuses its close control",
    detail?.getAttribute("aria-hidden") === null && document.activeElement?.id === "detailClose",
  );
  const detailBody = document.getElementById("detailBody") as HTMLElement;
  detailBody.focus();
  key(detailBody, "Tab");
  ok("Tab wraps inside detail", document.activeElement?.id === "detailClose");
  key(document.activeElement ?? document, "Tab", true);
  ok("Shift+Tab wraps inside detail", document.activeElement?.id === "detailBody");
  key(document, "Escape");
  ok(
    "Escape closes detail and restores its scan row",
    detail?.getAttribute("aria-hidden") === "true" && document.activeElement === hostileOpen,
  );
  key(hostileOpen ?? document, " ");
  ok("Space opens detail", detail?.getAttribute("aria-hidden") === null);
  api.emitClear();
  ok(
    "clearing an open detail returns focus to the empty feed",
    detail?.getAttribute("aria-hidden") === "true" && document.activeElement?.id === "list",
  );

  console.log("\n=== pairing focus and safe Escape behavior ===");
  api.emitRepair();
  const pair = document.getElementById("pair");
  ok(
    "repair pairing is dismissible and initially focused",
    document.activeElement?.id === "server" &&
      !(document.getElementById("pairCancel") as HTMLButtonElement).hidden,
  );
  key(document.activeElement ?? document, "Tab", true);
  ok("Shift+Tab wraps inside pairing", document.activeElement?.id === "pairCancel");
  key(document.activeElement ?? document, "Tab");
  ok("Tab wraps inside pairing", document.activeElement?.id === "server");
  key(document, "Escape");
  ok(
    "Escape closes safe pairing and restores re-pair",
    pair?.getAttribute("aria-hidden") === "true" && document.activeElement?.id === "repairBtn",
  );
  api.emitUnpaired();
  key(document, "Escape");
  ok(
    "mandatory pairing cannot be dismissed",
    pair?.getAttribute("aria-hidden") === null &&
      (document.getElementById("pairCancel") as HTMLButtonElement).hidden,
  );
  (document.getElementById("server") as HTMLInputElement).value = "https://new.example";
  (document.getElementById("code") as HTMLInputElement).value = "ABCD-EFGH";
  document
    .getElementById("pairForm")
    ?.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
    );
  await flush();
  ok(
    "form submission pairs without a mouse",
    api.pairCalls[0]?.[0] === "https://new.example" && api.pairCalls[0]?.[1] === "ABCD-EFGH",
  );

  console.log("\n=== accessible state and quiet live updates ===");
  const status = document.getElementById("status");
  ok(
    "connection status is a polite atomic live region",
    status?.getAttribute("role") === "status" &&
      status.getAttribute("aria-live") === "polite" &&
      status.getAttribute("aria-atomic") === "true",
  );
  api.emitStatus({ state: "offline", detail: "timeout" });
  ok("connection failure is announced", status?.textContent?.includes("timeout"));
  api.emitClip({ ...emptyClipboard(), on: true, sentKind: "fit", delivered: 1 });
  const clipboardMessage = status?.textContent;
  runtime.intervals.forEach((callback) => callback());
  ok(
    "clipboard state is exposed without timer announcement spam",
    clipboardMessage?.includes("sent fit") && status?.textContent === clipboardMessage,
  );
  const clipButton = document.getElementById("clipBtn");
  ok(
    "clipboard toggle exposes its state",
    clipButton?.getAttribute("aria-pressed") === "true" &&
      clipButton.getAttribute("aria-label")?.startsWith("Disable"),
  );
  ok(
    "abbreviated controls have accessible names",
    ["quitBtn", "opBtn", "repairBtn", "clearBtn"].every((id) =>
      document.getElementById(id)?.hasAttribute("aria-label"),
    ),
  );
  ok(
    "all global actions retain native keyboard semantics",
    ["clipBtn", "clearBtn", "opBtn", "repairBtn", "quitBtn"].every(
      (id) => document.getElementById(id)?.tagName === "BUTTON",
    ),
  );

  console.log("\n=== contrast at every transparency level ===");
  const cssValue = (name: string): string => {
    const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(html);
    if (!match?.[1]) throw new Error("Missing CSS token " + name);
    return match[1].trim();
  };
  const rgb = (hex: string): [number, number, number] => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  const luminance = (color: [number, number, number]): number => {
    const channels = color.map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
  };
  const contrast = (a: [number, number, number], b: [number, number, number]): number => {
    const first = luminance(a),
      second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };
  const alphaMatches = [...html.matchAll(/body\.op\d \{ --bg: rgba\(16,17,19,\.(\d+)\);/g)];
  const alphas = alphaMatches.map((match) => Number("0." + match[1]));
  const foregrounds = ["text", "dim", "blue", "green", "amber", "red"].map((name) =>
    rgb(cssValue(name)),
  );
  const backdrops: Array<[number, number, number]> = [
    [0, 0, 0],
    [255, 255, 255],
  ];
  const textPasses =
    alphas.length === 3 &&
    alphas.every((alpha) =>
      backdrops.every((backdrop) => {
        const background = [16, 17, 19].map(
          (value, index) => value * alpha + (backdrop[index] ?? 0) * (1 - alpha),
        ) as [number, number, number];
        return (
          foregrounds.every((foreground) => contrast(foreground, background) >= 4.5) &&
          contrast(rgb(cssValue("control-border")), background) >= 3 &&
          contrast(rgb(cssValue("focus")), background) >= 3
        );
      }),
    );
  ok(
    "normal text and controls meet WCAG thresholds over black and white",
    textPasses,
    alphas.join(","),
  );
  ok(
    "filled controls retain readable white labels",
    ["blue-fill", "green-fill"].every(
      (name) => contrast([255, 255, 255], rgb(cssValue(name))) >= 4.5,
    ),
  );

  cleanup();
}

test("renderer behavior, accessibility, and hostile payloads", run);
