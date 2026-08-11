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
> Windows SmartScreen can show **Windows protected your PC** because the
> executable is not code-signed. Verify the download, select **More info**, and
> then select **Run anyway**.

### Verify a download

Each release includes a SHA-256 checksum beside the executable. For a stable
release, replace `<version>` with the version downloaded; for a continuous
build, use `MILF-Viewer-latest.exe`.

```powershell
$download = "MILF-Viewer-<version>.exe"
$expected = ((Get-Content "$download.sha256" -Raw) -split '\s+')[0]
$actual = (Get-FileHash $download -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -cne $expected) { throw "SHA-256 checksum mismatch for $download" }
```

GitHub also records signed build provenance for stable and continuous
executables. Stable releases include an SPDX JSON software bill of materials
and an SBOM attestation. See [RELEASING.md](docs/RELEASING.md) for the complete
verification commands.

## Setup

1. Download and run the viewer.
2. Open the MiniLuv dashboard and select **Pair viewer**.
3. Enter the dashboard address and one-time pairing code in the viewer.
4. New scans appear as they are posted.

The viewer remembers its dashboard address, encrypted pairing credential,
window position, and opacity under `%APPDATA%\milf-viewer`. Use **Re-pair** in
viewer settings or the tray menu to connect it to another dashboard.

## Features

- Live scan feed with hull, pilot, value, tank, route, fleet, and notes
- Expandable fit and cargo details
- Always-on-top, resizable Windows overlay with three opacity levels
- Per-scan bump controls and locally counted countdown timers
- Tray controls for showing, clearing, repositioning, and re-pairing
- Optional clipboard watching for EVE fits and cargo lists
- Replay recovery after brief network interruptions
- Connection freshness, last-event time, and privacy-safe diagnostics
- Independent compact feed filters using text and minimum split value
- Opt-in desktop alerts with quiet hours, persistent mute, and configurable
  split-value, hull, system, or route conditions
- Stable-release awareness with release notes and a deliberate browser download action
- Single-instance behavior so duplicate launches focus the existing window

## Privacy and security

Clipboard watching is **off by default** and visibly indicated when enabled.
Classification happens locally before any request is made. The filter rejects
secrets, URLs, email addresses, source code, prose, and content that does not
match the paired dashboard's EVE item vocabulary. If the vocabulary is
unavailable, the filter fails closed and sends nothing.

Desktop alerts are also **off by default**. Alert matching happens locally and
is independent of visible-feed filters. Notifications use generic lock-screen
text unless **Show intel details on the lock screen** is explicitly enabled.
Retained and replayed scans never produce desktop alerts.

The renderer is sandboxed, has no Node.js integration, and communicates through
a narrow typed preload bridge. Pairing credentials are encrypted with Electron
`safeStorage` and never exposed to renderer JavaScript. Authenticated traffic
requires HTTPS except for an explicit loopback-only development switch.

The viewer checks GitHub for the latest stable release at most once per day. It
does not download, execute, or replace the application. The download action
opens only this repository's validated GitHub release page in the system
browser; users should still verify the published checksum and provenance.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development

Requirements:

- Windows 10 or later
- Node.js 22.x
- npm

Electron 43 bundles Node.js 24 for the packaged runtime. Contributors and CI
still use Node.js 22 as declared by `package.json`.

Install the locked dependencies and run from source:

```powershell
npm ci
npm start
```

Run the normal tests during development:

```powershell
npm test
```

Before publishing or merging release-affecting changes, run the complete gate:

```powershell
npm run verify
```

The full gate checks formatting, lint rules, and TypeScript types; runs Node and
real-Electron tests; builds `dist\MILF-Viewer-<version>.exe`; and launches the
packaged artifact for a render-and-quit smoke test.

For detailed setup, packaging, troubleshooting, and manual Windows checks, see
[BUILD.md](docs/BUILD.md). Outside contributors should also read
[CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture and protocol

Electron's main process owns credentials, networking, clipboard access,
persistence, and native windows. A context-isolated preload bridge exposes only
validated viewer operations to the sandboxed renderer. The viewer pairs over
bounded JSON requests and consumes a capability-negotiated SSE feed with replay
cursor and duplicate suppression.

The viewer supports dashboard protocol version 1, remains usable with legacy
dashboards, disables unsafe writes for newer protocol versions, and has no
runtime dependency on dashboard source packages. See
[ARCHITECTURE.md](docs/ARCHITECTURE.md) for component responsibilities, trust
boundaries, data flow, protocol capabilities, replay behavior, and compatibility
rules.

## Release automation

GitHub Actions builds pull requests, updates a rolling `continuous` prerelease
from `main`, and creates stable releases from exact `v<package.json version>`
tags whose commits are part of `main`. Stable releases contain the executable,
checksum, SPDX SBOM, and attestations. Build/test jobs are read-only, and
publication happens in separate least-privilege jobs.

See [RELEASING.md](docs/RELEASING.md) for the canonical release procedure.

## Project policies

- [MIT License](LICENSE)
- [Contributing](CONTRIBUTING.md)
- [Security and supported versions](SECURITY.md)
