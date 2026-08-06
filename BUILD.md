# Building MILF Viewer

Produces a single `MILF-Viewer-0.1.0.exe`. No installer, no Node needed on the
machine that runs it — double-click and it opens.

## Once, on a Windows box

```
npm install
npm run verify
```

The exe lands in `dist\MILF-Viewer-0.1.0.exe`, around 90 MB. That's Electron —
it bundles a browser runtime, which is the cost of the window floating over the
game without touching the client.

## Distributing it

Drop the exe wherever MiniLuv shares files. It's self-contained: first run
unpacks to a temp directory and starts. Non-secret settings (server address,
window position, opacity, and clipboard preference) go in
`%APPDATA%\milf-viewer\settings.json`. The bearer credential is encrypted with
Electron `safeStorage` into `credential.bin`; an older plaintext settings token
is migrated and removed on the next successful startup. Settings and the
vocabulary cache are written by atomic replacement. If either JSON file is
malformed, the original is retained beside it with a `.corrupt-<timestamp>`
name before a fresh file is created.

**Windows SmartScreen will warn on first run** — "Windows protected your PC" —
because the exe isn't code-signed. More Info → Run anyway. Signing needs a
certificate (~£200/yr), which is probably not worth it for a SIG tool, but tell
people it's coming so it doesn't look like malware.

## Developing

```
npm start
```

Runs from source with the same behaviour.

Normal dashboard addresses require HTTPS. To connect a development build to a
plain-HTTP dashboard on `localhost`, `127.0.0.0/8`, or `::1`, opt in for that
launch only:

```
npm start -- --allow-insecure-localhost
```

`npm start`, `npm test`, and `npm run build` compile TypeScript into `.build\`
before launching their respective command. The generated JavaScript is ignored
and can be deleted at any time.

`npm test` includes portable Node tests and a real-Electron suite backed by a
local mock dashboard. `npm run verify` also checks formatting and lint rules,
builds the portable executable, and launches that exact artifact to confirm the
pairing window renders and the process quits cleanly. Failure artifacts are
written under `output\playwright\`.

## Manual Windows smoke test

After `npm run build`, close any development copy and launch
`dist\MILF-Viewer-0.1.0.exe`. Before publishing, verify all of the following:

1. The transparent always-on-top window opens and can cycle through all three opacity levels.
2. Pairing succeeds, the connection becomes live, and a scan opens its detail view.
3. Bump and clear controls work and bump countdowns continue through a feed re-render.
4. Clipboard watching starts only after clicking its control, reports a capture, and can be turned off again.
5. Tray Show, Clear feed, Re-pair, Reset position, and Quit actions remain reachable.
6. Re-pairing removes the old feed state, and Quit exits both the window and tray process.
7. `settings.json` contains no bearer token after pairing or legacy migration; `credential.bin` is present and opaque.
8. Remote HTTP and loopback HTTP without the development switch show actionable pairing errors.
9. The packaged renderer still reports `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` in its compiled main-process configuration.
10. Disconnecting the dashboard changes the viewer to reconnecting within the bounded timeout, and restoring it resumes a single live feed.
11. Rapidly pairing to another dashboard never reconnects to or displays events from the previous dashboard.
12. Move and resize the viewer rapidly, select Quit immediately, then relaunch and confirm the final bounds were retained.
13. Place the viewer on a secondary monitor, including one with negative desktop coordinates, and confirm it reopens on that display.
14. Change that display's resolution or DPI, or unplug it, and confirm the running and relaunched viewer remain fully reachable.
15. Use Reset position while the viewer is on both primary and secondary displays and confirm it resets within the nearest display's work area.

The automated packaged smoke covers launch, local rendering, and shutdown. The
pairing, tray, live-feed, bump, clipboard, multi-monitor, and DPI checks above
remain manual release checks and require a compatible dashboard where noted.

## If you'd rather not build

`npm install && npm start` works on any machine with Node 22. The build step
only exists so users don't need Node.
