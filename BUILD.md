# Building MILF Viewer

MILF Viewer is a portable Windows application. Packaging produces one
`dist\MILF-Viewer-<version>.exe`; users do not need Node.js or an installer.

## Requirements

- Windows 10 or later
- Node.js 22.x
- npm

Node.js 22 is the supported development and CI runtime declared by
`package.json`. Electron 43 includes Node.js 24 inside the packaged application;
that bundled runtime does not change the development requirement.

## Install and run from source

Install the exact locked dependencies from a clean checkout:

```powershell
npm ci
npm start
```

Dashboard addresses normally require HTTPS. To connect a development build to
plain HTTP on `localhost`, `127.0.0.0/8`, or `::1`, opt in for that launch only:

```powershell
npm start -- --allow-insecure-localhost
```

Private-LAN and public HTTP addresses remain blocked.

## Test and package

Run the standard test suite while developing:

```powershell
npm test
```

This runs the Node tests and a serial real-Electron integration suite against a
local mock dashboard. Failed browser tests retain screenshots, traces, console
output, and mock request logs under `output\playwright\`.

Before publishing or merging a release-affecting change, run the complete gate:

```powershell
npm run verify
```

The verification gate checks formatting, lint rules, and TypeScript types; runs
the test suites; creates the portable executable; and launches that exact
artifact to confirm the pairing window renders and the process exits cleanly.

To package without running the complete gate:

```powershell
npm run build
```

The output path is `dist\MILF-Viewer-<version>.exe`, where `<version>` is read
from `package.json`. TypeScript is compiled into the ignored `.build\` directory
before development, tests, and packaging. Generated JavaScript is disposable
and must not be committed.

## Packaged behavior

The executable is self-contained and unpacks into a temporary directory when it
starts. Non-secret settings are stored in
`%APPDATA%\milf-viewer\settings.json`. The bearer credential is encrypted with
Electron `safeStorage` in `credential.bin`; a legacy plaintext settings token is
migrated and removed after a successful startup.

Settings and the vocabulary cache use atomic replacement. If either JSON file
is malformed, the original is retained beside it with a
`.corrupt-<timestamp>` suffix before a fresh file is created.

Windows SmartScreen can warn on the first launch because the executable is not
code-signed. Users should verify the release checksum and provenance before
selecting **More info** and **Run anyway**.

## Manual Windows smoke test

After `npm run build`, close any development copy and launch
`dist\MILF-Viewer-<version>.exe`. Before publishing, verify all of the following:

1. The transparent always-on-top window opens and cycles through all three opacity levels.
2. Pairing succeeds, the connection becomes live, and a scan opens its detail view.
3. Bump and clear controls work and bump countdowns continue through a feed re-render.
4. Clipboard watching starts only after clicking its control, reports a capture, and can be turned off again.
5. Tray Show, Clear feed, Re-pair, Reset position, and Quit actions remain reachable.
6. Re-pairing removes the old feed state, and Quit exits both the window and tray process.
7. `settings.json` contains no bearer token after pairing or legacy migration; `credential.bin` is present and opaque.
8. Remote HTTP and loopback HTTP without the development switch show actionable pairing errors.
9. The packaged renderer uses `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
10. Disconnecting the dashboard changes the viewer to reconnecting within the bounded timeout, and restoring it resumes one live feed.
11. Rapidly pairing to another dashboard never reconnects to or displays events from the previous dashboard.
12. Moving and resizing rapidly, quitting immediately, and relaunching retains the final bounds.
13. A window saved on a secondary display, including one with negative coordinates, reopens on that display.
14. Changing that display's resolution or DPI, or unplugging it, leaves the running and relaunched viewer reachable.
15. Reset position works from primary and secondary displays and resets within the nearest display's work area.

The automated packaged smoke test covers launch, local rendering, and shutdown.
Pairing, tray, live-feed, bump, clipboard, multi-monitor, and DPI checks remain
manual and require a compatible dashboard where noted.

## Windows build troubleshooting

Close all development and packaged copies before rebuilding. The tray process
can keep Electron running after its window is hidden and can hold files in
`dist\`. To stop stale processes explicitly:

```powershell
taskkill /IM "MILF Viewer.exe" /F
taskkill /IM electron.exe /F
```

Then remove the old `dist\` output and rebuild. If dependency replacement is
blocked, close editors or file watchers using `node_modules\`, then rerun
`npm ci`. Do not commit `node_modules\`, `.build\`, `dist\`, or `output\`; they
are reproducible generated content.
