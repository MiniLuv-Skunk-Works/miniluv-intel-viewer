# Architecture and Dashboard Protocol

This document describes the runtime boundaries and compatibility model that
maintainers must preserve. It is an overview, not a second source of truth for
the TypeScript contracts.

## Runtime boundaries

MILF Viewer uses Electron's main, preload, and renderer separation:

1. `main.ts` composes the application, owns Electron lifecycle events, and
   coordinates graceful shutdown.
2. `viewer-controller.ts` orchestrates pairing, protocol state, feed events,
   bump requests, vocabulary loading, clipboard relay, and unpairing.
3. Main-process modules own privileged operations: HTTPS requests and SSE,
   encrypted credentials, settings files, clipboard access, windows, displays,
   and the tray.
4. `preload.ts` exposes the narrow typed `window.milf` API through Electron's
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
`contracts.ts` describe accepted application objects, while `validation.ts`
centralizes string, list, timestamp, and numeric bounds. Network failures are
normalized before they reach the renderer and must not expose credentials.

## Persistence and credentials

Non-secret settings remain in memory and are written atomically to
`settings.json` after a debounce. The EVE vocabulary cache uses the same safe
replacement model. Corrupt JSON is preserved with a `.corrupt-<timestamp>`
suffix rather than silently overwritten.

The dashboard bearer credential is stored separately in `credential.bin` and
encrypted with Electron `safeStorage` on Windows. A legacy plaintext token is
migrated and removed. Decryption failure returns the viewer to pairing without
placing the token in logs, IPC, or renderer state.

## Dashboard protocol version 1

The dashboard is the wire-protocol source of truth. The viewer keeps local
runtime parsers and a representative fixture so it can be released and tested
without importing private dashboard packages.

Pairing exchanges a one-time code for an encrypted-at-rest bearer credential.
Authenticated bounded JSON requests provide vocabulary, bump control, and
clipboard relay. The live feed is Server-Sent Events (SSE). Its `hello` event
advertises the dashboard `protocolVersion`, capabilities, and replay state;
subsequent events carry scans, bumps, and cleared bumps.

Version 1 recognizes these capabilities:

- `scan-feed`
- `bump-control`
- `clipboard-relay`
- `clipboard-vocabulary`
- `scan-replay`

Unknown capability strings are ignored. A version-1 dashboard that omits a
known capability remains connected, but the corresponding optional operation
is unavailable.

## Replay and connection ownership

When `scan-replay` is advertised, each scan frame places its stable scan ID in
the SSE `id` field. The viewer retains the latest validated, HTTP-header-safe
cursor in memory for the current pairing and sends it as `Last-Event-ID` after
a network interruption. Replayed and live events are deduplicated by stable scan
ID. Bump events do not advance the scan cursor.

If a cursor cannot be represented safely in an HTTP header, the viewer sends
the last safe cursor and accepts a wider replay window; deduplication removes
the overlap. A `hello.replay.status` of `cursor-expired` means the dashboard no
longer retains the requested position. The viewer warns about the unrecoverable
gap and accepts the complete retained window that follows.

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

Alert and filter preferences are non-secret settings validated on disk and at
the IPC boundary. The sandboxed renderer may edit those preferences, but the
main process evaluates alert rules and owns Electron's native notification API.
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

- A hello event without `protocolVersion` or `capabilities` is legacy. Existing
  feed, bump, and clipboard behavior remains available.
- Protocol version 1 uses capability negotiation for optional operations.
- A newer protocol version can continue supplying the basic scan feed, but the
  viewer displays a compact warning and disables writes and clipboard relay
  until that version is supported.
- Additive fields do not require a protocol version increase. Semantic changes
  do, and optional behavior should be advertised with a capability.

The portable viewer fixture is
`tests/fixtures/viewer-protocol-v1.json`. To test a dashboard checkout's fixture
against the viewer parsers:

```powershell
$env:DASHBOARD_VIEWER_PROTOCOL_FIXTURE = "D:\path\to\dashboard\packages\contracts\fixtures\viewer-protocol-v1.json"
npm test
Remove-Item Env:DASHBOARD_VIEWER_PROTOCOL_FIXTURE
```

The viewer has no runtime dependency on dashboard source, TypeScript packages,
or its fixture path.
