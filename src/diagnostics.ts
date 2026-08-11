import type {
  ConnectionStatus,
  DiagnosticError,
  DiagnosticsSnapshot,
  UpdateInfo,
} from "./contracts";

const ERROR_MESSAGES = Object.freeze({
  "feed-timeout": "The dashboard feed timed out.",
  "feed-unreachable": "The dashboard feed could not be reached.",
  "feed-response": "The dashboard returned an unusable feed response.",
  "feed-invalid": "The dashboard feed sent invalid data.",
  "settings-read": "Stored settings could not be read.",
  "settings-write": "Stored settings could not be saved.",
  "credential-store": "Secure credential storage is unavailable.",
  "update-check": "The release check could not be completed.",
  "external-link": "The release page could not be opened.",
  notification: "Desktop notifications are unavailable.",
} as const);

export class DiagnosticsRecorder {
  private readonly errors: DiagnosticError[] = [];
  private connection: ConnectionStatus = { state: "unpaired" };
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  setConnection(connection: ConnectionStatus): void {
    this.connection = { ...connection };
  }

  record(code: keyof typeof ERROR_MESSAGES): void {
    this.errors.push({ at: this.now(), code, message: ERROR_MESSAGES[code] });
    if (this.errors.length > 10) this.errors.shift();
  }

  snapshot(appVersion: string, serverOrigin: string, update: UpdateInfo): DiagnosticsSnapshot {
    return {
      appVersion,
      serverOrigin,
      connection: { ...this.connection },
      errors: this.errors.map((error) => ({ ...error })),
      update,
    };
  }
}
