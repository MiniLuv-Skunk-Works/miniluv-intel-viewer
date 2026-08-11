import { parseDashboardOrigin } from "../src/dashboard-url";
import { ok } from "./support/assertions";

console.log("\n=== dashboard origin policy ===");
const normalized = parseDashboardOrigin("  https://Dashboard.Example:8443/path?q=1#frag  ", false);
ok(
  "HTTPS is normalized to an origin",
  normalized.ok && normalized.origin === "https://dashboard.example:8443",
);
ok(
  "HTTPS loopback needs no development exception",
  parseDashboardOrigin("https://localhost/test", false).ok,
);
ok(
  "URL credentials are rejected",
  !parseDashboardOrigin("https://user:pass@example.test", false).ok,
);
ok("non-HTTP protocols are rejected", !parseDashboardOrigin("file:///tmp/dashboard", true).ok);
ok("malformed addresses are rejected", !parseDashboardOrigin("not a url", false).ok);
ok(
  "oversized addresses are rejected",
  !parseDashboardOrigin("https://" + "a".repeat(2_048), false).ok,
);

console.log("\n=== explicit loopback HTTP exception ===");
ok(
  "loopback HTTP is disabled by default",
  !parseDashboardOrigin("http://localhost:3000", false).ok,
);
ok("localhost works with the flag", parseDashboardOrigin("http://localhost:3000/path", true).ok);
ok("127/8 works with the flag", parseDashboardOrigin("http://127.42.0.9:3000", true).ok);
ok("IPv6 loopback works with the flag", parseDashboardOrigin("http://[::1]:3000", true).ok);
ok(
  "lookalike localhost is remote",
  !parseDashboardOrigin("http://localhost.example:3000", true).ok,
);
ok(
  "private-network HTTP remains rejected",
  !parseDashboardOrigin("http://192.168.1.20:3000", true).ok,
);
ok("public HTTP remains rejected", !parseDashboardOrigin("http://dashboard.example", true).ok);
