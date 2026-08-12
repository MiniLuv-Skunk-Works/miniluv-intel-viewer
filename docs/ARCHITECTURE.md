# Architecture and Dashboard Protocol

This document describes the runtime boundaries and compatibility model that
maintainers must preserve. It is an overview, not a second source of truth for
the TypeScript contracts.

## Repository layout

- `src/` contains all application TypeScript and renderer assets.
- `tests/` contains unit, Electron, and packaged-application tests.
- `scripts/` contains build tooling, while `build/` contains packaging assets.
- `docs/` contains architecture, build, release, and planning documentation.
- `.build/`, `dist/`, and `output/` are generated and are not source directories.

## Runtime boundaries

MILF Viewer uses Electron's main, preload, and renderer separation:

1. `src/main.ts` composes the application, owns Electron lifecycle events, and
   coordinates graceful shutdown.
2. `src/viewer-controller.ts` orchestrates pairing, protocol state, feed events,
   bump requests, vocabulary loading, clipboard relay, and unpairing.
3. Main-process modules own privileged operations: HTTPS requests and SSE,
   encrypted credentials, settings files, clipboard access, windows, displays,
   and the tray.
4. `src/preload.ts` exposes the narrow typed `window.milf` API through Electron's
   context bridge.
5. The sandboxed renderer builds the interface with browser APIs and receives
   only validated, user-safe data. It has no Node.js or filesystem access.

The renderer uses context isolation, disables Node integration, blocks
navigation and new windows, and runs under a restrictive Content Security
Policy. IPC handlers accept calls only from the viewer window's main frame and
validate every request before changing application state.

## Main-process data flow

Pairing and feed data follow this path:

```text
renderer -> preload -> validated IPC -> viewer controller
                                      |-> dashboard client -> dashboard JSON APIs
                                      |-> feed connection -> dashboard SSE feed
                                      |-> credential/settings stores -> Windows user data
                                      |-> clipboard watcher -> local classification/relay

dashboard event -> runtime parser -> viewer controller -> window manager
                                                    -> preload event -> renderer
```

External JSON, SSE frames, stored files, and renderer IPC arguments are treated
as unknown until their runtime parsers succeed. The shared types in
`src/contracts.ts` describe accepted application objects, while `src/validation.ts`
centralizes string, list, timestamp, and numeric bounds. Network failures are
normalized before they reach the renderer and must not expose credentials.

## Persistence and credentials

Non-secret settings, including the universal combat scenario, remain in memory
and are written atomically to `settings.json` after a debounce. Older valid
preference files without a scenario migrate to the safe default: prepped, 0.5
security, active tank, and no implant package. The EVE vocabulary cache uses the
same safe replacement model. Corrupt JSON is preserved with a
`.corrupt-<timestamp>` suffix rather than silently overwritten.

The dashboard bearer credential is stored separately in `credential.bin` and
encrypted with Electron `safeStorage` on Windows. A legacy plaintext token is
migrated and removed. Decryption failure returns the viewer to pairing without
placing the token in logs, IPC, or renderer state.

## Dashboard protocol version 2

The dashboard is the wire-protocol source of truth. The viewer keeps local
runtime parsers and a representative fixture so it can be released and tested
without importing private dashboard packages.

Pairing exchanges a one-time code for an encrypted-at-rest bearer credential.
Authenticated bounded JSON requests provide vocabulary, bump control,
clipboard relay, and request-scoped scenario calculations. The live feed is
Server-Sent Events (SSE). Its `hello` event
advertises the dashboard `protocolVersion`, capabilities, and replay state;
subsequent events carry scans, scan removals, bumps, and cleared bumps.

Version 2 recognizes these capabilities:

- `scan-feed`
- `bump-control`
- `clipboard-relay`
- `clipboard-vocabulary`
- `scan-replay`
- `scan-updates`
- `scan-removals`
- `scenario-calculation`

Unknown capability strings are ignored. A version-2 dashboard that omits a
known capability remains connected, but the corresponding optional operation
is unavailable.

Scan events contain shared scan facts only. They do not contain scenario
choices, EHP, DPS, fleet requirements, or the dashboard's private tank context.
The scenario-calculation contract accepts 1 to 25 unique scan IDs and a complete
`{ state, securityStatus, tankState, implant }` scenario. Its response preserves
request order and classifies each ID as `ready`, `unavailable`, or `not-found`.
The renderer persists one local combat scenario, keeps calculation results in a
map separate from scan facts, and renders cards and details from that map. It
batches the retained replay after replay settles, refreshes one stable scan ID
for a live publication or revision, and refreshes all retained IDs when a
scenario control changes. Scenario generations and per-scan request epochs
prevent older responses from replacing newer selections or revisions.

Bump events carry the authoritative server epoch `at`, total `holdMs`, and the
server-calculated `remainingMs`. The viewer prefers `remainingMs` so wall-clock
skew cannot lengthen a hold. After receipt, countdown painting uses only the
local monotonic clock. Bump state is not persisted because the dashboard
remains the source of truth.

## Replay and connection ownership

When `scan-replay` is advertised, each scan frame places its publication
revision ID in the SSE `id` field. The revision ID is independent from the
payload's stable `scan.id`, which remains the identity used by the renderer and
bump controls. The viewer retains the latest validated, HTTP-header-safe
revision cursor in memory for the current pairing and sends it as
`Last-Event-ID` after a network interruption. Replayed and live events are
deduplicated by revision ID, so a new revision of an existing stable scan is
delivered as an in-place update. Scan-removal tombstones also advance the
cursor, so a deletion made during a network interruption is applied after
reconnect. Bump events do not advance the scan cursor.

If a cursor cannot be represented safely in an HTTP header, the viewer sends
the last safe cursor and accepts a wider replay window; deduplication removes
the overlap. A `hello.replay.status` of `cursor-expired` means the dashboard no
longer retains the requested position. The viewer warns about the unrecoverable
gap, clears its prior local list, and accepts the complete retained window that follows.

The cursor is not persisted to disk. Starting the application or changing
pairings requests the dashboard's normal retained snapshot. The feed connection
module owns the only active request, retry timer, generation, idle timeout, and
jittered backoff so stale callbacks cannot reconnect an old pairing.

The visible connection phase distinguishes connecting, replaying, live, stale,
and offline. Thirty seconds without stream bytes marks the feed stale; the
existing sixty-second idle boundary closes it and starts bounded retry. The
last-event timestamp advances only for successfully parsed hello, scan, bump,
or bump-clear events. Replay alerting stays disarmed until one second passes
without another retained scan.

## User preferences, notifications, and updates

Alert, filter, and combat-scenario preferences are non-secret settings validated
on disk and at the IPC boundary. The sandboxed renderer may edit those
preferences, but the main process evaluates alert rules, owns Electron's native
notification API, and performs authenticated scenario-calculation requests. The
scenario is not added to shared scan events or persisted by the dashboard.
Alert matching uses `valueSplit`; configured alert categories use OR semantics,
while the compact text/minimum-value feed filters use AND semantics and never
affect alert evaluation.

Diagnostics expose only app version, validated dashboard origin, connection
metadata, last-event time, and ten fixed redacted error descriptions. They do
not include credentials, scan payloads, server response bodies, query strings,
or filesystem paths.

The update checker makes a bounded HTTPS request to GitHub's latest stable
release endpoint no more than once per day unless the user requests a check.
Release metadata is strictly parsed and cached atomically. The renderer receives
plain text only; opening the release uses a main-process allowlist for this
repository. No artifact is downloaded or executed by the viewer.

## Compatibility rules

- A hello event without `protocolVersion` or `capabilities` is incompatible.
- Protocol versions below or above 2 are rejected; no scan-only fallback is
  provided across this semantic break.
- Protocol version 2 uses capability negotiation for optional operations.
- Additive fields do not require a protocol version increase. Semantic changes
  do, and optional behavior should be advertised with a capability.

The portable viewer fixture is
`tests/fixtures/viewer-protocol-v2.json`. The v1 fixture is retained only to
prove rejection. To test a dashboard checkout's fixture
against the viewer parsers:

```powershell
$env:DASHBOARD_VIEWER_PROTOCOL_FIXTURE = "D:\path\to\dashboard\packages\contracts\fixtures\viewer-protocol-v2.json"
npm test
Remove-Item Env:DASHBOARD_VIEWER_PROTOCOL_FIXTURE
```

The viewer has no runtime dependency on dashboard source, TypeScript packages,
or its fixture path.
