# Building MILF Viewer

Produces a single `MILF-Viewer-0.1.0.exe`. No installer, no Node needed on the
machine that runs it — double-click and it opens.

## Once, on a Windows box

```
npm install
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

## If you'd rather not build

`npm install && npm start` works on any machine with Node 18+. The build step
only exists so users don't need Node.
