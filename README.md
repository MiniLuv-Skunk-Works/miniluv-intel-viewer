# MILF Viewer

MILF Viewer is the Windows desktop client for the **MiniLuv Intel Live Feed**.
It keeps current scan intel in a compact, always-on-top window without injecting
into EVE Online or modifying the game client.

## Download

- [Latest stable release](https://github.com/MiniLuv-Skunk-Works/miniluv-intel-viewer/releases/latest)
- [Latest continuous build](https://github.com/MiniLuv-Skunk-Works/miniluv-intel-viewer/releases/download/continuous/MILF-Viewer-latest.exe) - rebuilt after every push to `main`

The download is a self-contained portable `.exe`; there is no installer and the
target machine does not need Node.js.

> [!NOTE]
> Windows SmartScreen may show **Windows protected your PC** because the
> executable is not code-signed. Select **More info**, then **Run anyway**.

## Setup

1. Download and run the viewer.
2. Open the MiniLuv dashboard and select **Pair viewer**.
3. Enter the dashboard address and one-time pairing code in the viewer.
4. New scans will appear as they are posted.

The viewer remembers its dashboard address, encrypted pairing credential,
window position, and opacity under `%APPDATA%\milf-viewer`. Use **Re-pair** in
the header or tray menu to connect it to a different dashboard.

## Features

- Live scan feed with hull, pilot, value, tank, route, fleet, and notes
- Expandable fit and cargo details
- Always-on-top, resizable Windows overlay with three opacity levels
- Per-scan bump controls and locally counted countdown timers
- Tray controls for showing, clearing, repositioning, and re-pairing the viewer
- Optional clipboard watching for EVE fits and cargo lists
- Single-instance behavior so duplicate launches focus the existing window

## Clipboard privacy

Clipboard watching is **off by default** and is visibly indicated when enabled.
Classification happens inside the viewer before any network request is made.
The filter rejects secrets, URLs, email addresses, source code, prose, and data
that does not match the EVE item vocabulary supplied by the paired dashboard.
If that vocabulary is unavailable, the filter fails closed and sends nothing.

## Development

Requirements:

- Windows 10 or later
- Node.js 22
- npm

Install dependencies and run from source:

```powershell
npm ci
npm start
```

Dashboard addresses must use HTTPS. For a loopback-only development dashboard,
plain HTTP can be enabled for that launch without changing stored settings:

```powershell
npm start -- --allow-insecure-localhost
```

The exception accepts only `localhost`, `127.0.0.0/8`, and `::1`; private-LAN
and public HTTP addresses remain blocked.

### Runtime support policy

The viewer currently targets Electron 43.2.x (Chromium 150 and Node.js 24).
Electron supports its latest three stable major versions, so maintainers should
review each stable Electron release and upgrade before the installed major
reaches end of life. Electron 43 reaches end of life on January 5, 2027. Patch
and minor updates within the selected major are accepted through the package
range and locked by `package-lock.json`.

Type-check the application and tests, then run the portable test suite:

```powershell
npm run typecheck
npm test
```

Development, tests, and packaging compile TypeScript into the ignored
`.build\` directory automatically. Generated JavaScript is disposable and
must not be committed.

The clipboard tests can additionally compare their slot-header rule with a
dashboard checkout when `DASHBOARD_CORE_PARSER` points to the dashboard's
`packages/core/src/parsing/index.ts` file.

### Dashboard protocol compatibility

This viewer supports dashboard protocol version 1. A version-1 dashboard with
all four known capabilities (`scan-feed`, `bump-control`, `clipboard-relay`,
and `clipboard-vocabulary`) is fully compatible. Unknown capability names are
ignored so dashboards can add optional features independently.

Compatibility is deliberately friendly to independent releases:

- A dashboard hello without `protocolVersion` or `capabilities` is treated as
  legacy. Existing feed, bump, and clipboard behavior remains available.
- A version-1 dashboard that omits a known capability remains connected, while
  the corresponding optional viewer operation is unavailable.
- A dashboard with a newer protocol version still supplies the basic scan
  feed. The viewer shows a compact warning and disables writes and clipboard
  relay until that protocol version is supported.
- Adding fields does not require a protocol version increase. Semantic changes
  do, and new optional behavior should be advertised as a capability.

The viewer has no runtime dependency on dashboard source or packages. It keeps
a self-contained representative fixture at
`tests/fixtures/viewer-protocol-v1.json`. To exercise a dashboard checkout's
portable fixture through the viewer parsers, run:

```powershell
$env:DASHBOARD_VIEWER_PROTOCOL_FIXTURE = "D:\path\to\dashboard\packages\contracts\fixtures\viewer-protocol-v1.json"
npm test
Remove-Item Env:DASHBOARD_VIEWER_PROTOCOL_FIXTURE
```

Build the portable executable:

```powershell
npm run build
```

The artifact is written to `dist\MILF-Viewer-<version>.exe`. Close any running
copy of MILF Viewer before rebuilding so Windows releases the existing file.

## Release automation

GitHub Actions handles the build paths:

- Pull requests targeting `main` run the tests, build the Windows executable,
  and retain it as a workflow artifact for 14 days.
- Pushes to `main` update the rolling `continuous` prerelease and its stable
  `MILF-Viewer-latest.exe` download URL.
- Tags matching `v*` build a versioned stable release.

See [RELEASING.md](RELEASING.md) for release notes, signing considerations, and
manual recovery steps.

## Project layout

| Path | Purpose |
| --- | --- |
| `main.ts` | Electron main process, pairing, feed connection, tray, and clipboard polling |
| `preload.ts` | Narrow, typed IPC bridge exposed to the sandboxed renderer |
| `contracts.ts` | Shared IPC/domain types and runtime boundary parsers |
| `dashboard-url.ts` | HTTPS and explicit loopback-development origin policy |
| `credentials.ts` | OS-encrypted bearer credential storage and migration |
| `ipc-security.ts` | Viewer-window and main-frame IPC authorization |
| `validation.ts` | Central string, list, timestamp, and numeric bounds |
| `renderer/` | TypeScript viewer interface, static HTML, icons, and live countdown behavior |
| `clipboard-filter.ts` | Local, fail-closed fit and cargo classifier |
| `tests/*.ts` | Portable behavior, security, clipboard, and contract checks |
| `scripts/build-code.mjs` | Disposable esbuild production/test compilation |
| `.github/workflows/` | PR, continuous, and stable release automation |

## Security model

The renderer uses context isolation, disables Node integration, enables the
Electron sandbox, blocks navigation and new windows, and enforces a Content
Security Policy. The pairing token is never exposed to renderer JavaScript or
stored as plaintext: Electron `safeStorage` protects `credential.bin` with the
Windows user account's DPAPI key. Authenticated traffic requires HTTPS except
for the explicit loopback-only development switch. The viewer is a separate
desktop application and does not inject code into EVE.
