import {
  defaultUserPreferences,
  parseCombatScenario,
  type ActiveBump,
  type CombatScenario,
  type ConnectionState,
  type ConnectionStatus,
  type DiagnosticsSnapshot,
  type OpacityLevel,
  type Scan,
  type ViewerApi,
  type UserPreferences,
  type UpdateInfo,
  type ViewerScenarioCalculationResult,
} from "../contracts";
import { scanMatchesFilter } from "../alerting";

export interface RendererRuntime {
  dateNow(): number;
  monotonicNow(): number;
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
}

export const browserRuntime: RendererRuntime = {
  dateNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  setInterval: (callback, delay) => window.setInterval(callback, delay),
  clearInterval: (id) => window.clearInterval(id),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (id) => window.clearTimeout(id),
};

interface Elements {
  viewerShell: HTMLElement;
  server: HTMLInputElement;
  code: HTMLInputElement;
  pairForm: HTMLFormElement;
  pairBtn: HTMLButtonElement;
  opBtn: HTMLButtonElement;
  quitBtn: HTMLButtonElement;
  pairCancel: HTMLButtonElement;
  detailClose: HTMLButtonElement;
  repairBtn: HTMLButtonElement;
  clipBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  filterBtn: HTMLButtonElement;
  muteBtn: HTMLButtonElement;
  settingsBtn: HTMLButtonElement;
  diagBtn: HTMLButtonElement;
  filterClear: HTMLButtonElement;
  settingsClose: HTMLButtonElement;
  diagnosticsClose: HTMLButtonElement;
  settingsSave: HTMLButtonElement;
  checkUpdateBtn: HTMLButtonElement;
  openUpdateBtn: HTMLButtonElement;
  detailTitle: HTMLElement;
  detailBody: HTMLElement;
  detail: HTMLElement;
  list: HTMLElement;
  dot: HTMLElement;
  status: HTMLElement;
  liveStatus: HTMLElement;
  pair: HTMLElement;
  pairErr: HTMLElement;
  filterPanel: HTMLElement;
  filterQuery: HTMLInputElement;
  filterValue: HTMLInputElement;
  settings: HTMLElement;
  settingsForm: HTMLFormElement;
  settingsErr: HTMLElement;
  alertsEnabled: HTMLInputElement;
  alertValue: HTMLInputElement;
  alertHulls: HTMLInputElement;
  alertSystems: HTMLInputElement;
  alertRoutes: HTMLInputElement;
  sensitiveAlerts: HTMLInputElement;
  quietEnabled: HTMLInputElement;
  quietStart: HTMLInputElement;
  quietEnd: HTMLInputElement;
  diagnostics: HTMLElement;
  diagVersion: HTMLElement;
  diagOrigin: HTMLElement;
  diagState: HTMLElement;
  diagLastEvent: HTMLElement;
  diagnosticErrors: HTMLElement;
  updateSummary: HTMLElement;
  releaseNotes: HTMLElement;
  scenarioPrepped: HTMLInputElement;
  scenarioUnprepped: HTMLInputElement;
  scenarioSecurity: HTMLSelectElement;
  scenarioTank: HTMLSelectElement;
  scenarioImplant: HTMLSelectElement;
}

interface ScanElements {
  open: HTMLElement;
  age: HTMLElement;
  bumpRow: HTMLElement;
  bumpBar: HTMLElement;
  bumpLeft: HTMLElement;
  bumpWho: HTMLElement;
}

type Overlay = "detail" | "pair" | "settings" | "diagnostics" | null;
type CalculationPhase = "pending" | "ready" | "stale" | "unavailable";

interface CalculationView {
  scenario: CombatScenario;
  phase: CalculationPhase;
  result?: ViewerScenarioCalculationResult;
  message?: string;
}

const MAX_RETAINED_SCANS = 25;

export function startRenderer(
  api: ViewerApi,
  doc: Document = document,
  runtime: RendererRuntime = browserRuntime,
): () => void {
  function $<K extends keyof Elements>(id: K): Elements[K] {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`Missing renderer element #${id}`);
    return node as Elements[K];
  }
  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function appendSpan(parent: HTMLElement, className: string, text: string): HTMLElement {
    const node = element("span", className, text);
    parent.append(node);
    return node;
  }

  const intervalIds = new Set<number>();
  const every = (callback: () => void, delay: number): void => {
    intervalIds.add(runtime.setInterval(callback, delay));
  };
  let scans: Scan[] = [];
  const scanElements = new Map<string, ScanElements[]>();
  const bumps: Record<string, ActiveBump> = {};
  let activeOverlay: Overlay = null;
  let diagnosticsReturnsToSettings = false;
  let detailScanId: string | null = null;
  let pairDismissible = false;
  let pairReturnFocus: HTMLElement | null = null;
  let paired = false;
  let protocolNotice: ConnectionStatus | null = null;
  let clipMsgTimer: number | null = null;
  let bumpErrTimer: number | null = null;
  let noticeTimer: number | null = null;
  let preferences: UserPreferences = defaultUserPreferences();
  const calculations = new Map<string, CalculationView>();
  const calculationEpochs = new Map<string, number>();
  let calculationGeneration = 0;
  let calculationEpoch = 0;
  let currentStatus: ConnectionStatus = { state: "connecting" };
  let currentUpdate: UpdateInfo = { status: "unknown", currentVersion: "unknown" };
  let visibleNotice: string | null = null;

  function isk(n: number | null | undefined): string | null {
    if (n == null || isNaN(n)) return null;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(0) + "M";
    return Math.round(n).toLocaleString();
  }
  function ehpFmt(n: number | null | undefined): string | null {
    if (n == null || isNaN(n)) return null;
    return n >= 1e6 ? (n / 1e6).toFixed(2) + "m" : (n / 1e3).toFixed(0) + "k";
  }
  function sameScenario(left: CombatScenario, right: CombatScenario): boolean {
    return (
      left.state === right.state &&
      left.securityStatus === right.securityStatus &&
      left.tankState === right.tankState &&
      left.implant === right.implant
    );
  }
  function titleCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  function tankContext(scenario = preferences.combatScenario): string {
    return (
      titleCase(scenario.tankState) +
      " tank \u00B7 " +
      (scenario.implant === "none" ? "no implants" : titleCase(scenario.implant))
    );
  }
  function fleetContext(scenario = preferences.combatScenario): string {
    return titleCase(scenario.state) + " \u00B7 " + scenario.securityStatus + " security";
  }
  function scenarioContext(scenario = preferences.combatScenario): string {
    return tankContext(scenario) + " \u00B7 " + fleetContext(scenario);
  }
  function currentCalculation(id: string): CalculationView | undefined {
    const calculation = calculations.get(id);
    return calculation && sameScenario(calculation.scenario, preferences.combatScenario)
      ? calculation
      : undefined;
  }
  function tier(v: number | null | undefined): string {
    if (v == null) return "t1";
    if (v >= 3e9) return "t4";
    if (v >= 1e9) return "t3";
    if (v >= 5e8) return "t2";
    return "t1";
  }
  function ageText(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return seconds + "s";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
    return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
  }
  function scanName(scan: Scan): string {
    return [
      scan.hull || "Unknown",
      scan.pilot ? "pilot " + scan.pilot : null,
      scan.system ? "in " + scan.system : null,
    ]
      .filter(Boolean)
      .join(", ");
  }
  function addKv(parent: DocumentFragment, key: string, value: string | null | undefined): void {
    if (!value) return;
    const row = element("div", "kv");
    row.append(element("b", undefined, key), doc.createTextNode(value));
    parent.append(row);
  }
  function addSection(parent: DocumentFragment, title: string, text: string): void {
    parent.append(element("h3", undefined, title), element("pre", undefined, text));
  }

  function setShellInert(on: boolean): void {
    $("viewerShell").inert = on;
    if (on) $("viewerShell").setAttribute("aria-hidden", "true");
    else $("viewerShell").removeAttribute("aria-hidden");
  }
  function focusScanOrList(id: string | null): void {
    const row = id === null ? undefined : scanElements.get(id)?.[0]?.open;
    (row ?? $("list")).focus();
  }
  function closeDetail(restoreFocus = true): void {
    if (activeOverlay !== "detail") return;
    const restoreId = detailScanId;
    $("detail").classList.remove("show");
    $("detail").setAttribute("aria-hidden", "true");
    activeOverlay = null;
    detailScanId = null;
    setShellInert(false);
    if (restoreFocus) focusScanOrList(restoreId);
  }
  function openDetail(id: string, focusClose = true): void {
    const scan = scans.find((candidate) => candidate.id === id);
    if (!scan || activeOverlay === "pair") return;
    $("detailTitle").textContent = (scan.hull || "Unknown") + "  \u00B7  " + (scan.system || "?");
    const body = doc.createDocumentFragment();
    addKv(body, "Scout", scan.scout);
    addKv(body, "Pilot", scan.pilot);
    addKv(
      body,
      "Route",
      [
        scan.scanGate ? scan.scanGate + " gate" : null,
        scan.headGate ? "\u2192 " + scan.headGate : null,
      ]
        .filter(Boolean)
        .join("  "),
    );
    addKv(
      body,
      "Value",
      [
        isk(scan.valueSplit) ? isk(scan.valueSplit) + " split" : null,
        isk(scan.valueSell) ? isk(scan.valueSell) + " sell" : null,
        isk(scan.valueBuy) ? isk(scan.valueBuy) + " buy" : null,
      ]
        .filter(Boolean)
        .join("  /  "),
    );
    addKv(body, "Droppable", isk(scan.droppableSplit) ? isk(scan.droppableSplit) + " split" : "");
    const calculation = currentCalculation(scan.id);
    const ready = calculation?.result?.status === "ready" ? calculation.result : undefined;
    body.append(element("h3", undefined, "Tank \u2014 " + tankContext()));
    if (ready) {
      addKv(
        body,
        ready.tank.selectedProfile,
        Math.round(ready.tank.selectedEhp).toLocaleString() +
          " EHP" +
          (ready.tank.overridden ? " \u00B7 manual override" : "") +
          (calculation?.phase === "stale" ? " \u00B7 stale" : ""),
      );
    } else {
      body.append(
        element(
          "div",
          "kv missing",
          calculation?.message ??
            (calculation?.phase === "pending"
              ? "Refreshing calculation\u2026"
              : "Calculation unavailable."),
        ),
      );
    }
    body.append(element("h3", undefined, "Fleet needed \u2014 " + fleetContext()));
    if (ready) {
      body.append(
        element(
          "pre",
          undefined,
          ready.requirements
            .map((entry) => String(entry.name).padEnd(9) + String(entry.ships).padStart(4))
            .join("\n"),
        ),
      );
    } else {
      body.append(
        element(
          "div",
          "kv missing",
          calculation?.message ??
            (calculation?.phase === "pending"
              ? "Refreshing calculation\u2026"
              : "Calculation unavailable."),
        ),
      );
    }
    if (scan.fitEft) addSection(body, "Fit \u2014 paste into Pyfa", scan.fitEft);
    const cargo = scan.cargoList || [];
    if (cargo.length) {
      addSection(
        body,
        "Cargo",
        cargo
          .map((entry) => Number(entry.qty).toLocaleString().padStart(11) + "  " + entry.name)
          .join("\n"),
      );
    }
    if (scan.notes) addSection(body, "Notes", scan.notes);
    if (!scan.fitEft && !cargo.length) {
      body.append(
        element("h3", undefined, "Fit & cargo"),
        element("div", "kv missing", "Not included in this scan."),
      );
    }
    $("detailBody").replaceChildren(body);
    $("detailBody").setAttribute("aria-label", "Details for " + scanName(scan));
    detailScanId = id;
    activeOverlay = "detail";
    setShellInert(true);
    $("detail").classList.add("show");
    $("detail").removeAttribute("aria-hidden");
    if (focusClose) $("detailClose").focus();
  }

  function closePair(restoreFocus = true): void {
    if (activeOverlay !== "pair") return;
    $("pair").classList.remove("show");
    $("pair").setAttribute("aria-hidden", "true");
    $("pairErr").textContent = "";
    activeOverlay = null;
    setShellInert(false);
    if (restoreFocus) {
      const firstRendered = scanElements.values().next().value;
      const target = pairReturnFocus?.isConnected ? pairReturnFocus : firstRendered?.[0]?.open;
      (target ?? $("list")).focus();
    }
    pairReturnFocus = null;
  }
  function showPair(on: boolean, dismissible = false, returnFocus?: HTMLElement): void {
    if (!on) {
      closePair(false);
      return;
    }
    if (activeOverlay === "detail") closeDetail(false);
    if (activeOverlay === "settings") closeSettings(false);
    if (activeOverlay === "diagnostics") closeDiagnostics(false);
    pairDismissible = dismissible;
    const activeElement = doc.activeElement;
    pairReturnFocus =
      returnFocus ??
      (activeElement && activeElement !== doc.body
        ? (activeElement as HTMLElement)
        : $("repairBtn"));
    $("pairCancel").hidden = !dismissible;
    activeOverlay = "pair";
    setShellInert(true);
    $("pair").classList.add("show");
    $("pair").removeAttribute("aria-hidden");
    $("server").focus();
  }

  function closeSettings(restoreFocus = true): void {
    if (activeOverlay !== "settings") return;
    $("settings").classList.remove("show");
    $("settings").setAttribute("aria-hidden", "true");
    activeOverlay = null;
    setShellInert(false);
    if (restoreFocus) $("settingsBtn").focus();
  }

  function minutesText(minutes: number): string {
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }

  function inputMinutes(value: string): number | null {
    const match = /^(\d\d):(\d\d)$/.exec(value);
    if (!match) return null;
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    return minutes >= 0 && minutes < 1_440 ? minutes : null;
  }

  function preferenceList(value: string): string[] {
    const seen = new Set<string>();
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => {
        const key = item.toLocaleLowerCase();
        if (!item || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function fillSettings(): void {
    const alerts = preferences.alerts;
    $("alertsEnabled").checked = alerts.enabled;
    $("alertValue").value =
      alerts.minimumSplitValue === null ? "" : String(alerts.minimumSplitValue);
    $("alertHulls").value = alerts.hulls.join(", ");
    $("alertSystems").value = alerts.systems.join(", ");
    $("alertRoutes").value = alerts.routes.join(", ");
    $("sensitiveAlerts").checked = alerts.includeSensitiveDetails;
    $("quietEnabled").checked = alerts.quietHours.enabled;
    $("quietStart").value = minutesText(alerts.quietHours.startMinute);
    $("quietEnd").value = minutesText(alerts.quietHours.endMinute);
    $("settingsErr").textContent = "";
  }

  function openSettings(): void {
    if (activeOverlay === "detail") closeDetail(false);
    if (activeOverlay === "diagnostics") closeDiagnostics(false);
    fillSettings();
    activeOverlay = "settings";
    setShellInert(true);
    $("settings").classList.add("show");
    $("settings").removeAttribute("aria-hidden");
    $("settingsClose").focus();
  }

  function renderUpdate(update: UpdateInfo): void {
    currentUpdate = update;
    const summary = {
      unknown: `Current version ${update.currentVersion}.`,
      checking: "Checking for a stable release…",
      "up-to-date": `Up to date (${update.currentVersion}).`,
      available: `Version ${update.latestVersion ?? "unknown"} is available.`,
      error: update.error || "The release check failed.",
    }[update.status];
    $("updateSummary").textContent = summary;
    $("releaseNotes").textContent = update.notes || "";
    $("releaseNotes").hidden = !update.notes;
    $("openUpdateBtn").hidden = update.status !== "available" || !update.releaseUrl;
    $("checkUpdateBtn").disabled = update.status === "checking";
  }

  function renderDiagnostics(snapshot: DiagnosticsSnapshot): void {
    $("diagVersion").textContent = snapshot.appVersion;
    $("diagOrigin").textContent = snapshot.serverOrigin || "Not paired";
    $("diagState").textContent = snapshot.connection.state;
    $("diagLastEvent").textContent = snapshot.connection.lastEventAt
      ? new Date(snapshot.connection.lastEventAt).toLocaleString()
      : "Never";
    const entries = snapshot.errors.length
      ? snapshot.errors.map((error) =>
          element("li", undefined, `${new Date(error.at).toLocaleTimeString()} — ${error.message}`),
        )
      : [element("li", undefined, "None")];
    $("diagnosticErrors").replaceChildren(...entries);
    renderUpdate(snapshot.update);
  }

  function closeDiagnostics(restoreFocus = true): void {
    if (activeOverlay !== "diagnostics") return;
    $("diagnostics").classList.remove("show");
    $("diagnostics").setAttribute("aria-hidden", "true");
    if (restoreFocus && diagnosticsReturnsToSettings) {
      diagnosticsReturnsToSettings = false;
      activeOverlay = "settings";
      $("settings").classList.add("show");
      $("settings").removeAttribute("aria-hidden");
      $("diagBtn").focus();
      return;
    }
    diagnosticsReturnsToSettings = false;
    activeOverlay = null;
    setShellInert(false);
    if (restoreFocus) $("settingsBtn").focus();
  }

  function openDiagnostics(): void {
    if (activeOverlay === "detail") closeDetail(false);
    diagnosticsReturnsToSettings = activeOverlay === "settings";
    if (diagnosticsReturnsToSettings) {
      $("settings").classList.remove("show");
      $("settings").setAttribute("aria-hidden", "true");
    }
    activeOverlay = "diagnostics";
    setShellInert(true);
    $("diagnostics").classList.add("show");
    $("diagnostics").removeAttribute("aria-hidden");
    $("diagnosticsClose").focus();
    void api.diagnostics().then(renderDiagnostics);
    renderUpdate(currentUpdate);
  }

  const focusableSelector = [
    "button:not([disabled])",
    "input:not([disabled])",
    "[href]",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");
  function focusableWithin(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(
      (node) => !node.hidden && node.getAttribute("aria-hidden") !== "true",
    );
  }
  function onDocumentKeydown(event: KeyboardEvent): void {
    if (!activeOverlay) return;
    if (event.key === "Escape") {
      if (activeOverlay === "detail") {
        event.preventDefault();
        closeDetail();
      } else if (activeOverlay === "pair" && pairDismissible) {
        event.preventDefault();
        closePair();
      } else if (activeOverlay === "settings") {
        event.preventDefault();
        closeSettings();
      } else if (activeOverlay === "diagnostics") {
        event.preventDefault();
        closeDiagnostics();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const root =
      activeOverlay === "detail"
        ? $("detail")
        : activeOverlay === "settings"
          ? $("settings")
          : activeOverlay === "diagnostics"
            ? $("diagnostics")
            : $("pair");
    const focusable = focusableWithin(root);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!root.contains(doc.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  }
  doc.addEventListener("keydown", onDocumentKeydown);

  function registerScanElements(id: string, rendered: ScanElements): void {
    const existing = scanElements.get(id);
    if (existing) existing.push(rendered);
    else scanElements.set(id, [rendered]);
  }
  function refreshOpenDetail(): void {
    if (activeOverlay === "detail" && detailScanId) openDetail(detailScanId, false);
  }
  function repaintCalculations(): void {
    render();
    refreshOpenDetail();
  }
  function requestCalculations(scanIds: string[]): void {
    const retainedIds = new Set(scans.map((scan) => scan.id));
    const ids = [...new Set(scanIds)]
      .filter((id) => retainedIds.has(id))
      .slice(0, MAX_RETAINED_SCANS);
    if (!ids.length) return;
    const scenario = { ...preferences.combatScenario };
    const generation = calculationGeneration;
    calculationEpoch += 1;
    const epoch = calculationEpoch;
    ids.forEach((id) => {
      calculationEpochs.set(id, epoch);
      const previous = currentCalculation(id);
      calculations.set(id, {
        scenario,
        phase: previous?.result?.status === "ready" ? "stale" : "pending",
        ...(previous?.result?.status === "ready" ? { result: previous.result } : {}),
        ...(previous?.result?.status === "ready"
          ? { message: "Refreshing stale tank and fleet values\u2026" }
          : {}),
      });
    });
    repaintCalculations();
    void api
      .calculateScenario({ scanIds: ids, scenario })
      .then((outcome) => {
        if (
          generation !== calculationGeneration ||
          !sameScenario(scenario, preferences.combatScenario)
        ) {
          return;
        }
        if (!outcome.ok) {
          ids.forEach((id) => {
            if (calculationEpochs.get(id) !== epoch) return;
            const previous = currentCalculation(id);
            calculations.set(id, {
              scenario,
              phase: previous?.result?.status === "ready" ? "stale" : "unavailable",
              ...(previous?.result?.status === "ready" ? { result: previous.result } : {}),
              message:
                outcome.reason === "rate-limited"
                  ? "Calculations rate-limited; retrying after reconnect."
                  : outcome.message,
            });
          });
          repaintCalculations();
          return;
        }
        outcome.response.results.forEach((result) => {
          if (calculationEpochs.get(result.scanId) !== epoch) return;
          calculations.set(
            result.scanId,
            result.status === "ready"
              ? { scenario, phase: "ready", result }
              : {
                  scenario,
                  phase: "unavailable",
                  result,
                  message:
                    result.status === "not-found"
                      ? "This retained scan has expired."
                      : "Tank context is unavailable for this scan.",
                },
          );
        });
        repaintCalculations();
      })
      .catch(() => {
        if (
          generation !== calculationGeneration ||
          !sameScenario(scenario, preferences.combatScenario)
        ) {
          return;
        }
        ids.forEach((id) => {
          if (calculationEpochs.get(id) !== epoch) return;
          calculations.set(id, {
            scenario,
            phase: "unavailable",
            message: "Calculation request failed.",
          });
        });
        repaintCalculations();
      });
  }
  function markCalculationsStale(): void {
    let changed = false;
    calculations.forEach((calculation, id) => {
      if (
        calculation.phase === "ready" &&
        calculation.result?.status === "ready" &&
        sameScenario(calculation.scenario, preferences.combatScenario)
      ) {
        calculations.set(id, {
          ...calculation,
          phase: "stale",
          message: "Tank and fleet values are stale while disconnected.",
        });
        changed = true;
      }
    });
    if (changed) repaintCalculations();
  }
  function paintScenarioControls(): void {
    const scenario = preferences.combatScenario;
    $("scenarioPrepped").checked = scenario.state === "prepped";
    $("scenarioUnprepped").checked = scenario.state === "unprepped";
    $("scenarioSecurity").value = scenario.securityStatus;
    $("scenarioTank").value = scenario.tankState;
    $("scenarioImplant").value = scenario.implant;
  }
  function applyScenario(scenario: CombatScenario, persist: boolean): void {
    const changed = !sameScenario(preferences.combatScenario, scenario);
    preferences = { ...preferences, combatScenario: { ...scenario } };
    paintScenarioControls();
    if (!changed) return;
    calculationGeneration += 1;
    calculationEpochs.clear();
    calculations.clear();
    repaintCalculations();
    if (persist) void api.savePreferences(preferences);
    requestCalculations(scans.map((scan) => scan.id));
  }
  function scenarioChanged(): void {
    const scenario = parseCombatScenario({
      state: $("scenarioPrepped").checked ? "prepped" : "unprepped",
      securityStatus: $("scenarioSecurity").value,
      tankState: $("scenarioTank").value,
      implant: $("scenarioImplant").value,
    });
    if (scenario) applyScenario(scenario, true);
  }
  $("scenarioPrepped").addEventListener("change", scenarioChanged);
  $("scenarioUnprepped").addEventListener("change", scenarioChanged);
  $("scenarioSecurity").addEventListener("change", scenarioChanged);
  $("scenarioTank").addEventListener("change", scenarioChanged);
  $("scenarioImplant").addEventListener("change", scenarioChanged);
  paintScenarioControls();

  function createScan(scan: Scan): HTMLElement {
    const article = element("article", "scan");
    const open = element("div", "scanOpen");
    open.tabIndex = 0;
    open.setAttribute("role", "button");
    open.setAttribute("aria-haspopup", "dialog");
    open.setAttribute("aria-label", "Open details for " + scanName(scan));
    const row1 = element("div", "row1");
    appendSpan(row1, "hull", scan.hull || "Unknown");
    if (scan.pilot) appendSpan(row1, "pilot", "(" + scan.pilot + ")");
    const age = appendSpan(row1, "age", "\u2014");
    open.append(row1);
    const bumpRow = element("div", "bumprow");
    bumpRow.hidden = true;
    const bumpLeft = appendSpan(bumpRow, "bumpleft", "\u2014");
    const bumpTrack = element("span", "bumpbar");
    const bumpBar = element("i");
    bumpTrack.append(bumpBar);
    const bumpWho = appendSpan(bumpRow, "bumpwho", "");
    bumpRow.append(bumpTrack, bumpWho);
    bumpRow.setAttribute("role", "progressbar");
    bumpRow.setAttribute("aria-valuemin", "0");
    bumpRow.setAttribute("aria-valuemax", "100");
    bumpRow.setAttribute("aria-label", "Bump hold for " + scanName(scan));
    open.append(bumpRow);
    const sell = isk(scan.valueSell);
    const calculation = currentCalculation(scan.id);
    const ready = calculation?.result?.status === "ready" ? calculation.result : undefined;
    const ehp = ready ? ehpFmt(ready.tank.selectedEhp) : null;
    if (sell || ehp) {
      const row2 = element("div", "row2");
      if (sell) appendSpan(row2, "val " + tier(scan.valueSell), sell);
      if (ehp && ready) {
        appendSpan(
          row2,
          "ehp",
          ehp +
            " EHP vs " +
            ready.tank.selectedProfile +
            (ready.tank.overridden ? " \u00B7 override" : ""),
        );
      }
      open.append(row2);
    }
    const fleet = ready?.requirements.slice(0, 4) ?? [];
    if (fleet.length) {
      const fleetRow = element("div", "fleet");
      fleet.forEach((entry, index) => {
        if (index) fleetRow.append(doc.createTextNode("  "));
        fleetRow.append(
          element("b", undefined, String(entry.ships)),
          doc.createTextNode(" " + entry.name),
        );
      });
      open.append(fleetRow);
    }
    open.append(element("div", "calculationContext", scenarioContext()));
    if (!ready || calculation?.phase === "stale") {
      const message =
        calculation?.message ??
        (calculation?.phase === "pending"
          ? "Refreshing tank and fleet\u2026"
          : calculation?.phase === "stale"
            ? "Tank and fleet values are stale."
            : "Tank and fleet unavailable.");
      open.append(
        element(
          "div",
          "calculationState" + (calculation?.phase === "stale" ? " stale" : ""),
          message,
        ),
      );
    }
    const route = [
      scan.scanGate ? scan.scanGate + " gate" : null,
      scan.headGate ? "\u2192 " + scan.headGate : null,
    ]
      .filter(Boolean)
      .join("  ");
    if (route) open.append(element("div", "meta", route));
    open.append(
      element(
        "div",
        "meta",
        (scan.scout || "?") + (scan.system ? " \u00B7 scanned in " + scan.system : ""),
      ),
    );
    if (scan.notes) open.append(element("div", "notes", scan.notes));
    open.addEventListener("click", () => openDetail(scan.id));
    open.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openDetail(scan.id);
    });
    const bumpButton = element("button", "bumpbtn", "BUMP");
    bumpButton.type = "button";
    bumpButton.title = "Start or refresh the bump timer";
    bumpButton.setAttribute("aria-label", "Start or refresh bump timer for " + scanName(scan));
    bumpButton.addEventListener("click", () => sendBump(scan.id, bumpButton));
    article.append(open, bumpButton);
    registerScanElements(scan.id, { open, age, bumpRow, bumpBar, bumpLeft, bumpWho });
    return article;
  }
  function render(): void {
    scanElements.clear();
    const list = $("list");
    if (!scans.length) {
      list.replaceChildren(element("div", "empty", "Waiting for scans\u2026"));
      return;
    }
    const visible = scans.filter((scan) => scanMatchesFilter(scan, preferences.filters));
    if (!visible.length) {
      list.replaceChildren(element("div", "empty", "No scans match the active filters."));
      return;
    }
    const fragment = doc.createDocumentFragment();
    visible.forEach((scan) => fragment.append(createScan(scan)));
    list.replaceChildren(fragment);
    paintBumps();
    tick();
  }
  function tick(): void {
    const now = runtime.dateNow();
    scans.forEach((scan) => {
      const age = now - Number(scan.at);
      scanElements.get(scan.id)?.forEach((rendered) => {
        rendered.age.textContent = ageText(age);
        rendered.age.className =
          "age" + (age > 15 * 60e3 ? " dead" : age > 5 * 60e3 ? " stale" : "");
      });
    });
    paintConnectionStatus();
  }
  every(tick, 1000);

  function paintConnectionStatus(): void {
    const age = currentStatus.lastEventAt
      ? ` · last event ${ageText(runtime.dateNow() - currentStatus.lastEventAt)} ago`
      : " · no events yet";
    const label = {
      live: "Live",
      connecting: "Connecting…",
      reconnecting: "Reconnecting",
      replaying: "Replaying retained scans",
      stale: "Stale",
      offline: "Offline",
      error: "Error",
      unpaired: "Not paired",
      clip: "Live",
      warn: "Warning",
    }[currentStatus.state];
    $("status").textContent = visibleNotice
      ? `${label} · ${visibleNotice}`
      : label + age + (currentStatus.detail ? ` · ${currentStatus.detail}` : "");
  }

  function setStatus(status: ConnectionStatus): void {
    const previousState = currentStatus.state;
    let shown =
      status.lastEventAt === undefined && currentStatus.lastEventAt !== undefined
        ? { ...status, lastEventAt: currentStatus.lastEventAt }
        : status;
    if (shown.compatibility) protocolNotice = shown.state === "warn" ? shown : null;
    else if (shown.state === "live" && protocolNotice) shown = protocolNotice;
    if (shown.state === "unpaired") protocolNotice = null;
    const map: Record<ConnectionState, string> = {
      live: "live",
      connecting: "warn",
      reconnecting: "warn",
      replaying: "warn",
      stale: "warn",
      offline: "bad",
      error: "bad",
      unpaired: "",
      clip: "live",
      warn: "warn",
    };
    $("dot").className = "dot " + (map[shown.state] || "");
    const announcement = {
      live: "Connected",
      connecting: "Connecting\u2026",
      reconnecting: "Connection lost \u2014 retrying in " + (shown.detail || "a moment"),
      replaying: "Restoring retained scans",
      stale: "Feed is stale",
      offline: "Can't reach the dashboard" + (shown.detail ? " (" + shown.detail + ")" : ""),
      error: shown.detail || "Error",
      unpaired: shown.detail || "Not paired",
      clip: shown.detail || "Clipboard scan sent",
      warn: shown.detail || "Warning",
    }[shown.state];
    currentStatus = shown;
    paintConnectionStatus();
    $("liveStatus").textContent = announcement;
    if (
      shown.state === "connecting" ||
      shown.state === "reconnecting" ||
      shown.state === "replaying" ||
      shown.state === "stale" ||
      shown.state === "offline" ||
      shown.state === "error"
    ) {
      markCalculationsStale();
    }
    if (
      shown.state === "live" &&
      previousState !== "live" &&
      previousState !== "clip" &&
      previousState !== "warn"
    ) {
      requestCalculations(scans.map((scan) => scan.id));
    }
    if (shown.state === "unpaired") {
      paired = false;
      showPair(true, false);
    }
  }

  $("pairForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const button = $("pairBtn");
    const server = $("server").value.trim();
    const code = $("code").value.trim();
    if (!server || !code) {
      $("pairErr").textContent = "Both fields are needed.";
      return;
    }
    button.disabled = true;
    button.textContent = "Pairing\u2026";
    $("pairErr").textContent = "";
    void api.pair(server, code).then((result) => {
      button.disabled = false;
      button.textContent = "Pair";
      if (result.ok) {
        paired = true;
        $("code").value = "";
        closePair(false);
        focusScanOrList(scans[0]?.id ?? null);
      } else $("pairErr").textContent = result.error || "Pairing failed.";
    });
  });

  let opLevel: OpacityLevel = 1;
  const opacityLabels = ["solid", "default", "faint"] as const;
  function applyOpacity(level: OpacityLevel): void {
    opLevel = level;
    doc.body.className = "op" + level;
    const current = opacityLabels[level];
    const next = opacityLabels[((level + 1) % 3) as OpacityLevel];
    $("opBtn").textContent = current;
    $("opBtn").setAttribute("aria-label", `Window transparency: ${current}. Change to ${next}`);
  }
  $("opBtn").addEventListener("click", () => {
    applyOpacity(((opLevel + 1) % 3) as OpacityLevel);
    void api.setOpacity(opLevel);
  });
  $("quitBtn").addEventListener("click", () => {
    void api.quit();
  });
  $("pairCancel").addEventListener("click", () => {
    if (pairDismissible) closePair();
  });
  $("detailClose").addEventListener("click", () => closeDetail());
  $("repairBtn").addEventListener("click", () => {
    void api.unpair().then(() => {
      paired = false;
      showPair(true, false, $("settingsBtn"));
    });
  });
  api.onRepair(() => showPair(true, paired, $("settingsBtn")));

  function numericPreference(input: HTMLInputElement): number | null {
    if (!input.value.trim()) return null;
    const value = Number(input.value);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function saveFilters(): void {
    preferences.filters = {
      query: $("filterQuery").value.trim(),
      minimumSplitValue: numericPreference($("filterValue")),
    };
    const active = !!preferences.filters.query || preferences.filters.minimumSplitValue !== null;
    $("filterBtn").classList.toggle("armed", active);
    render();
    void api.savePreferences(preferences).then((saved) => {
      preferences = saved;
    });
  }

  $("filterBtn").addEventListener("click", () => {
    const hidden = $("filterPanel").hidden;
    $("filterPanel").hidden = !hidden;
    $("filterBtn").setAttribute("aria-pressed", String(hidden));
    if (hidden) $("filterQuery").focus();
  });
  $("filterQuery").addEventListener("input", saveFilters);
  $("filterValue").addEventListener("input", saveFilters);
  $("filterClear").addEventListener("click", () => {
    $("filterQuery").value = "";
    $("filterValue").value = "";
    saveFilters();
    $("filterQuery").focus();
  });

  function paintMute(): void {
    const muted = preferences.alerts.muted;
    $("muteBtn").classList.toggle("armed", muted);
    $("muteBtn").setAttribute("aria-pressed", String(muted));
    $("muteBtn").textContent = muted ? "unmute" : "mute";
    $("muteBtn").setAttribute(
      "aria-label",
      muted ? "Unmute desktop alerts" : "Mute desktop alerts",
    );
  }

  $("muteBtn").addEventListener("click", () => {
    preferences.alerts.muted = !preferences.alerts.muted;
    paintMute();
    void api.savePreferences(preferences).then((saved) => {
      preferences = saved;
      paintMute();
    });
  });

  $("settingsBtn").addEventListener("click", openSettings);
  $("settingsClose").addEventListener("click", () => closeSettings());
  $("settingsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const startMinute = inputMinutes($("quietStart").value);
    const endMinute = inputMinutes($("quietEnd").value);
    const hulls = preferenceList($("alertHulls").value);
    const systems = preferenceList($("alertSystems").value);
    const routes = preferenceList($("alertRoutes").value);
    const minimumSplitValue = numericPreference($("alertValue"));
    if (startMinute === null || endMinute === null) {
      $("settingsErr").textContent = "Enter valid quiet-hour times.";
      return;
    }
    if ($("quietEnabled").checked && startMinute === endMinute) {
      $("settingsErr").textContent = "Quiet-hour start and end must differ.";
      return;
    }
    if (
      $("alertsEnabled").checked &&
      minimumSplitValue === null &&
      !hulls.length &&
      !systems.length &&
      !routes.length
    ) {
      $("settingsErr").textContent = "Add at least one alert condition.";
      return;
    }
    if ([hulls, systems, routes].some((list) => list.length > 50)) {
      $("settingsErr").textContent = "Each alert list is limited to 50 names.";
      return;
    }
    preferences.alerts = {
      enabled: $("alertsEnabled").checked,
      muted: preferences.alerts.muted,
      includeSensitiveDetails: $("sensitiveAlerts").checked,
      minimumSplitValue,
      hulls,
      systems,
      routes,
      quietHours: { enabled: $("quietEnabled").checked, startMinute, endMinute },
    };
    $("settingsSave").disabled = true;
    void api.savePreferences(preferences).then((saved) => {
      preferences = saved;
      $("settingsSave").disabled = false;
      paintMute();
      closeSettings();
    });
  });

  $("diagBtn").addEventListener("click", openDiagnostics);
  $("diagnosticsClose").addEventListener("click", () => closeDiagnostics());
  $("checkUpdateBtn").addEventListener("click", () => {
    renderUpdate({ status: "checking", currentVersion: currentUpdate.currentVersion });
    void api.checkUpdate().then(renderUpdate);
  });
  $("openUpdateBtn").addEventListener("click", () => {
    void api.openUpdate();
  });
  api.onUpdate(renderUpdate);
  api.onNotice((notice) => {
    visibleNotice = notice.message;
    paintConnectionStatus();
    $("liveStatus").textContent = notice.message;
    if (noticeTimer !== null) runtime.clearTimeout(noticeTimer);
    noticeTimer = runtime.setTimeout(() => {
      visibleNotice = null;
      paintConnectionStatus();
    }, 8_000);
  });

  function setClipButton(on: boolean): void {
    $("clipBtn").classList.toggle("armed", on);
    $("clipBtn").setAttribute("aria-pressed", String(on));
    $("clipBtn").textContent = "clipboard: " + (on ? "on" : "off");
    $("clipBtn").setAttribute(
      "aria-label",
      (on ? "Disable" : "Enable") + " clipboard scan watching",
    );
  }
  $("clipBtn").addEventListener("click", () => {
    void api.clipwatch(!$("clipBtn").classList.contains("armed"));
  });
  api.onClipWatch((result) => {
    setClipButton(!!result.on);
    if (!result.on) {
      setStatus({ state: "live" });
      return;
    }
    if (result.error) {
      setStatus({ state: "error", detail: "clip: " + result.error });
      return;
    }
    if (result.sentKind) {
      const message = result.delivered
        ? "sent " + result.sentKind + " to the dashboard"
        : "captured a " + result.sentKind + " \u2014 no dashboard tab open";
      setStatus({ state: result.delivered ? "clip" : "warn", detail: message });
      if (clipMsgTimer !== null) runtime.clearTimeout(clipMsgTimer);
      clipMsgTimer = runtime.setTimeout(() => setStatus({ state: "live" }), 6000);
    }
  });
  void api.clipwatch(undefined).then((result) => setClipButton(!!result?.on));

  function clearScans(): void {
    const detailWasOpen = activeOverlay === "detail";
    if (detailWasOpen) closeDetail(false);
    calculationGeneration += 1;
    calculations.clear();
    calculationEpochs.clear();
    scans = [];
    render();
    if (detailWasOpen) $("list").focus();
  }
  $("clearBtn").addEventListener("click", () => {
    clearScans();
    closeSettings();
  });
  api.onClear(clearScans);

  function paintBumps(): void {
    const now = runtime.monotonicNow();
    Object.keys(bumps).forEach((id) => {
      const bump = bumps[id];
      if (!bump) return;
      const elapsed = Math.max(0, now - bump.receivedAt);
      const left = Math.max(0, bump.remainingMs - elapsed);
      const percent = Math.max(0, Math.min(100, (left / bump.totalMs) * 100));
      const seconds = Math.ceil(left / 1000);
      const label =
        left <= 0
          ? "OUT"
          : seconds >= 60
            ? Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0")
            : seconds + "s";
      scanElements.get(id)?.forEach((rendered) => {
        rendered.bumpRow.hidden = false;
        rendered.bumpBar.style.width = percent + "%";
        rendered.bumpLeft.textContent = label;
        rendered.bumpWho.textContent = bump.by + (bump.count > 1 ? "  \u00D7" + bump.count : "");
        rendered.bumpRow.className =
          "bumprow" + (left <= 0 ? " gone" : left <= 30000 ? " warn" : "");
        rendered.bumpRow.setAttribute("aria-valuenow", String(Math.round(percent)));
        rendered.bumpRow.setAttribute("aria-valuetext", label + " remaining, bumped by " + bump.by);
      });
    });
  }
  every(paintBumps, 250);
  function sendBump(id: string, button: HTMLButtonElement): void {
    button.disabled = true;
    button.textContent = "\u2026";
    void api.bump(id).then((result) => {
      button.disabled = false;
      button.textContent = "BUMP";
      if (result?.ok === false) {
        setStatus({ state: "error", detail: result.error || "bump failed" });
        if (bumpErrTimer !== null) runtime.clearTimeout(bumpErrTimer);
        bumpErrTimer = runtime.setTimeout(() => setStatus({ state: "live" }), 12000);
      }
    });
  }
  api.onBump((bump) => {
    const holdMs = Number(bump.holdMs);
    if (!Number.isFinite(holdMs) || holdMs < 0) return;
    const serverRemainingMs = Number(bump.remainingMs);
    const eventAt = Number(bump.at);
    let remainingMs: number;
    if (Number.isFinite(serverRemainingMs)) {
      remainingMs = serverRemainingMs;
    } else if (Number.isFinite(eventAt) && eventAt >= 0) {
      remainingMs = holdMs - Math.max(0, runtime.dateNow() - eventAt);
    } else {
      remainingMs = holdMs;
    }
    bumps[bump.scanId] = {
      ...bump,
      remainingMs: Math.max(0, Math.min(holdMs, remainingMs)),
      totalMs: Math.max(1, holdMs),
      receivedAt: runtime.monotonicNow(),
    };
    paintBumps();
  });
  api.onBumpCleared((event) => {
    delete bumps[event.scanId];
    scanElements.get(event.scanId)?.forEach((rendered) => {
      rendered.bumpRow.hidden = true;
    });
  });
  api.onScan((scan) => {
    const existingIndex = scans.findIndex((candidate) => candidate.id === scan.id);
    const refreshDetail = activeOverlay === "detail" && detailScanId === scan.id;
    calculations.delete(scan.id);
    calculationEpochs.delete(scan.id);
    if (existingIndex === -1) {
      scans.unshift(scan);
      if (scans.length > MAX_RETAINED_SCANS) {
        const evicted = scans.pop();
        if (evicted) {
          calculations.delete(evicted.id);
          calculationEpochs.delete(evicted.id);
        }
      }
    } else {
      scans[existingIndex] = scan;
    }
    render();
    if (refreshDetail) openDetail(scan.id, false);
    if (currentStatus.state === "live" && currentStatus.protocolVersion === 2) {
      requestCalculations([scan.id]);
    }
  });
  api.onStatus(setStatus);
  api.onUnpaired(() => {
    paired = false;
    calculationGeneration += 1;
    calculations.clear();
    calculationEpochs.clear();
    scans = [];
    render();
    showPair(true, false);
  });
  void api.state().then((state) => {
    paired = state.paired;
    if (state.serverUrl) $("server").value = state.serverUrl;
    applyOpacity(state.opacity == null ? 1 : state.opacity);
    if (state.paired) closePair(false);
    else showPair(true, false);
  });
  void api.preferences().then((saved) => {
    const scenarioChangedFromDefault = !sameScenario(
      preferences.combatScenario,
      saved.combatScenario,
    );
    preferences = saved;
    $("filterQuery").value = saved.filters.query;
    $("filterValue").value =
      saved.filters.minimumSplitValue === null ? "" : String(saved.filters.minimumSplitValue);
    const active = !!saved.filters.query || saved.filters.minimumSplitValue !== null;
    $("filterBtn").classList.toggle("armed", active);
    paintScenarioControls();
    paintMute();
    render();
    if (scenarioChangedFromDefault) {
      calculationGeneration += 1;
      calculations.clear();
      calculationEpochs.clear();
      requestCalculations(scans.map((scan) => scan.id));
    }
  });

  return () => {
    doc.removeEventListener("keydown", onDocumentKeydown);
    intervalIds.forEach((id) => runtime.clearInterval(id));
    if (clipMsgTimer !== null) runtime.clearTimeout(clipMsgTimer);
    if (bumpErrTimer !== null) runtime.clearTimeout(bumpErrTimer);
    if (noticeTimer !== null) runtime.clearTimeout(noticeTimer);
  };
}
