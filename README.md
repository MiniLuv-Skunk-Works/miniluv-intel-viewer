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

The viewer remembers its dashboard address, pairing token, window position, and
opacity under `%APPDATA%\milf-viewer`. Use **Re-pair** in the header or tray menu
to connect it to a different dashboard.

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

Run the portable test suite:

```powershell
npm test
```

The clipboard tests can additionally compare their slot-header rule with a
dashboard checkout when `DASHBOARD_CORE_PARSER` points to the dashboard's
`packages/core/src/parsing/index.ts` file.

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
| `main.js` | Electron main process, pairing, feed connection, tray, and clipboard polling |
| `preload.js` | Narrow IPC bridge exposed to the sandboxed renderer |
| `renderer/` | Viewer interface and live countdown behavior |
| `clipboard-filter.js` | Local, fail-closed fit and cargo classifier |
| `test-*.js` | Portable behavior, security, and clipboard checks |
| `.github/workflows/` | PR, continuous, and stable release automation |

## Security model

The renderer uses context isolation, disables Node integration, enables the
Electron sandbox, blocks navigation and new windows, and enforces a Content
Security Policy. The pairing token is never exposed to renderer JavaScript.
The viewer is a separate desktop application and does not inject code into EVE.
