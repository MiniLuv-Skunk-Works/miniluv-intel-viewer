import type { AlertPreferences, FilterPreferences, Scan } from "./contracts";

export interface AlertNotification {
  title: string;
  body: string;
}

export interface AlertServiceOptions {
  notify: (notification: AlertNotification) => void;
  supported: () => boolean;
  now?: () => Date;
}

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function listMatches(value: string | undefined, expected: readonly string[]): boolean {
  const candidate = normalized(value);
  return candidate.length > 0 && expected.some((item) => normalized(item) === candidate);
}

export function scanMatchesAlert(scan: Scan, preferences: AlertPreferences): boolean {
  const criteria = [
    preferences.minimumSplitValue !== null
      ? (scan.valueSplit ?? -1) >= preferences.minimumSplitValue
      : null,
    preferences.hulls.length ? listMatches(scan.hull, preferences.hulls) : null,
    preferences.systems.length ? listMatches(scan.system, preferences.systems) : null,
    preferences.routes.length
      ? preferences.routes.some(
          (route) =>
            normalized(route) === normalized(scan.scanGate) ||
            normalized(route) === normalized(scan.headGate),
        )
      : null,
  ].filter((matched): matched is boolean => matched !== null);
  return criteria.length > 0 && criteria.some(Boolean);
}

export function scanMatchesFilter(scan: Scan, preferences: FilterPreferences): boolean {
  if (
    preferences.minimumSplitValue !== null &&
    (scan.valueSplit ?? -1) < preferences.minimumSplitValue
  ) {
    return false;
  }
  const query = normalized(preferences.query);
  if (!query) return true;
  return [scan.hull, scan.pilot, scan.scout, scan.system, scan.scanGate, scan.headGate].some(
    (value) => normalized(value).includes(query),
  );
}

export function isQuietTime(preferences: AlertPreferences, date: Date): boolean {
  if (!preferences.quietHours.enabled) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  const { startMinute, endMinute } = preferences.quietHours;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

function compactSplitValue(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  if (value >= 1e9) return (value / 1e9).toFixed(2) + "B split";
  if (value >= 1e6) return (value / 1e6).toFixed(0) + "M split";
  return Math.round(value).toLocaleString() + " split";
}

export function notificationForScan(
  scan: Scan,
  includeSensitiveDetails: boolean,
): AlertNotification {
  if (!includeSensitiveDetails) {
    return {
      title: "MILF Viewer alert",
      body: "A new scan matched your alert settings. Open the viewer for details.",
    };
  }
  const title = [scan.hull || "Unknown hull", scan.system ? "in " + scan.system : null]
    .filter(Boolean)
    .join(" ");
  const route = [scan.scanGate, scan.headGate].filter(Boolean).join(" → ");
  const body = [compactSplitValue(scan.valueSplit), route || null].filter(Boolean).join(" · ");
  return { title, body: body || "A matching scan arrived." };
}

export class AlertService {
  private preferences: AlertPreferences;
  private armed = false;
  private readonly notify: AlertServiceOptions["notify"];
  private readonly supported: AlertServiceOptions["supported"];
  private readonly now: () => Date;

  constructor(preferences: AlertPreferences, options: AlertServiceOptions) {
    this.preferences = preferences;
    this.notify = options.notify;
    this.supported = options.supported;
    this.now = options.now ?? (() => new Date());
  }

  configure(preferences: AlertPreferences): void {
    this.preferences = preferences;
  }

  setArmed(armed: boolean): void {
    this.armed = armed;
  }

  handle(scan: Scan): boolean {
    if (
      !this.armed ||
      !this.preferences.enabled ||
      this.preferences.muted ||
      !this.supported() ||
      isQuietTime(this.preferences, this.now()) ||
      !scanMatchesAlert(scan, this.preferences)
    ) {
      return false;
    }
    this.notify(notificationForScan(scan, this.preferences.includeSensitiveDetails));
    return true;
  }
}
