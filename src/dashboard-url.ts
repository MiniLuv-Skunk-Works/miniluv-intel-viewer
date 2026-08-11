import { isIP } from "node:net";
import { VALIDATION_LIMITS, boundedString } from "./validation";

export type DashboardOriginErrorCode =
  "invalid" | "credentials" | "protocol" | "insecure-remote" | "local-http-disabled";

export type DashboardOriginResult =
  | { ok: true; origin: string; protocol: "https:" | "http:"; loopback: boolean }
  | { ok: false; code: DashboardOriginErrorCode; error: string };

function ipv4Loopback(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const firstOctet = Number(hostname.split(".", 1)[0]);
  return firstOctet === 127;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const unbracketed =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  return unbracketed === "localhost" || unbracketed === "::1" || ipv4Loopback(unbracketed);
}

export function parseDashboardOrigin(
  input: unknown,
  allowInsecureLocalhost: boolean,
): DashboardOriginResult {
  const raw = boundedString(input, VALIDATION_LIMITS.url, 1);
  if (raw === null) {
    return { ok: false, code: "invalid", error: "Enter a valid dashboard address." };
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: "invalid", error: "Enter a valid dashboard address." };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      code: "credentials",
      error: "Dashboard addresses cannot contain credentials.",
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, code: "protocol", error: "Dashboard addresses must use HTTPS." };
  }

  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === "http:" && !loopback) {
    return { ok: false, code: "insecure-remote", error: "Remote dashboards must use HTTPS." };
  }
  if (url.protocol === "http:" && !allowInsecureLocalhost) {
    return {
      ok: false,
      code: "local-http-disabled",
      error: "Loopback HTTP requires --allow-insecure-localhost.",
    };
  }

  return { ok: true, origin: url.origin, protocol: url.protocol, loopback };
}
