# Building MILF Viewer

Produces a single `MILF-Viewer-0.1.0.exe`. No installer, no Node needed on the
machine that runs it — double-click and it opens.

## Once, on a Windows box

```
npm install
npm run typecheck
npm test
npm run build
```

The exe lands in `dist\MILF-Viewer-0.1.0.exe`, around 90 MB. That's Electron —
it bundles a browser runtime, which is the cost of the window floating over the
game without touching the client.

## Distributing it

Drop the exe wherever MiniLuv shares files. It's self-contained: first run
unpacks to a temp directory and starts. Settings (server address, pairing
token, window position) go in
`%APPDATA%\milf-viewer\settings.json` and survive updates.

**Windows SmartScreen will warn on first run** — "Windows protected your PC" —
because the exe isn't code-signed. More Info → Run anyway. Signing needs a
certificate (~£200/yr), which is probably not worth it for a SIG tool, but tell
people it's coming so it doesn't look like malware.

## Developing

```
npm start
```

Runs from source with the same behaviour.

`npm start`, `npm test`, and `npm run build` compile TypeScript into `.build\`
before launching their respective command. The generated JavaScript is ignored
and can be deleted at any time.

## Packaged smoke test

After `npm run build`, close any development copy and launch
`dist\MILF-Viewer-0.1.0.exe`. Before publishing, verify all of the following:

1. The transparent always-on-top window opens and can cycle through all three opacity levels.
2. Pairing succeeds, the connection becomes live, and a scan opens its detail view.
3. Bump and clear controls work and bump countdowns continue through a feed re-render.
4. Clipboard watching starts only after clicking its control, reports a capture, and can be turned off again.
5. Tray Show, Clear feed, Re-pair, Reset position, and Quit actions remain reachable.
6. Re-pairing removes the old feed state, and Quit exits both the window and tray process.

The pairing, live-feed, bump, and clipboard checks require a compatible
dashboard. If one is unavailable, record those items as not exercised rather
than treating a successful launch as a complete smoke test.

## If you'd rather not build

`npm install && npm start` works on any machine with Node 22. The build step
only exists so users don't need Node.
