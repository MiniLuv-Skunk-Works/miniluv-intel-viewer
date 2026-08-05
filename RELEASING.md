# Releasing MILF Viewer on GitHub

Goal: someone clicks one link, gets one file, double-clicks it, and it runs.

---

## The manual way, once

1. Build it:

   ```
   npm install
   npm run build
   ```

   You get `dist\MILF-Viewer-0.1.0.exe`, around 90 MB.

2. On GitHub: **Releases** → **Draft a new release**

3. **Choose a tag** → type `v0.1.0` → *Create new tag on publish*

4. Title it `MILF Viewer 0.1.0`. In the body, say what changed and warn about
   SmartScreen — see the template below.

5. Drag the `.exe` into the **Attach binaries** box. Wait for the upload to
   finish before publishing, or the release goes out with no download.

6. **Publish release.**

The download URL is then predictable, which is handy for pinning in Discord:

```
https://github.com/<owner>/<repo>/releases/latest/download/MILF-Viewer-0.1.0.exe
```

`/releases/latest/download/` always points at the newest release, so a link in
a pinned message keeps working — **as long as the filename doesn't change**.
That's an argument for dropping the version from the artifact name once you're
past the first couple of releases.

## Automated builds

Pull requests build the portable executable and attach it to the workflow run
as a 14-day Actions artifact. Unmerged code is never published as a release.

Every push to `main` also updates the `continuous` prerelease and replaces
`MILF-Viewer-latest.exe`. Its permanent download URL is:

```
https://github.com/MiniLuv-Skunk-Works/miniluv-intel-viewer/releases/download/continuous/MILF-Viewer-latest.exe
```

Version tags such as `v0.1.0` still create stable releases through
`.github/workflows/release.yml`.

---

## Release notes template

```markdown
Download **MILF-Viewer-0.1.0.exe** below. No installer — double-click to run.

Windows will say "Windows protected your PC" the first time. That's because the
exe isn't code-signed, not because anything is wrong.
Click **More info** → **Run anyway**.

## Setup
1. Open the dashboard and click **Pair viewer**
2. In the viewer, enter the dashboard address and the code
3. Scans appear as they're posted

## This release
- ...
```

Say the SmartScreen thing every time. People who skip it assume it's malware
and quietly don't use the tool.

---

## Automating it

`.github/workflows/release.yml` — pushing a tag builds and publishes on its own:

```yaml
name: release
on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - uses: softprops/action-gh-release@v2
        with:
          files: dist/*.exe
          generate_release_notes: true
```

Then a release is:

```
git tag v0.1.1
git push origin v0.1.1
```

`runs-on: windows-latest` matters — electron-builder needs Windows to produce a
Windows exe. `npm ci` rather than `npm install` so the build uses the exact
locked versions.

---

## Signing, and whether it's worth it

Short version: **signing no longer makes the warning disappear on its own, and
for a tool 30 people download it probably isn't worth paying for.** Here's why.

### What changed

The CA/Browser Forum now requires every code signing key to live on a
FIPS-compliant hardware token or HSM. The old workflow — buy a cert, get a
`.pfx`, sign with it — is gone. You need a USB token ($90-250 on top of the
cert), a cloud HSM, or a managed service.

### The catch nobody mentions

An OV (Organization Validation) certificate — the affordable kind — still shows
a SmartScreen warning for a new publisher. It fades as download *reputation*
accumulates. Thirty downloads will not accumulate reputation in any useful
timeframe.

So paying for an OV cert may buy you a slightly different warning, not no
warning. That's the part worth knowing before spending money.

### If you do want to sign

**Azure Artifact Signing** (renamed from Trusted Signing in 2026) is the
cheapest sane option at roughly **$10/month**. No hardware, and certificates
come from Microsoft's own CA which Windows already trusts, so reputation starts
from a better place than a third-party OV cert. electron-builder supports it
natively:

```json
"win": {
  "sign": { "type": "azure" }
}
```

Credentials come from Azure Entra ID environment variables — set them as GitHub
Actions secrets, never in the repo.

Eligibility is the snag: verified US, Canadian, EU or UK businesses and
self-employed individuals, and some applicants need three years of trading
history. You're US-based, so it's plausible — worth checking before budgeting
for it.

**If the repo is public**, SignPath offers free signing for open-source
projects. Worth an application before paying anyone.

### What I'd actually do

Ship unsigned, and put the SmartScreen note in every release body. It's one
extra click for the user, and it's honest. Revisit if MiniLuv ever distributes
widely enough that reputation would actually build.

---

## Two things you hit

### It doesn't ask for a code again

Fixed. The cause was that the pairing screen only appeared when the *server*
rejected the token. If a token was stored but the server was unreachable, the
viewer sat on "reconnecting" forever with no way to reach pairing.

Now:

- **re-pair** button in the header, always available
- **Re-pair…** on the tray menu
- a 401 or 403 clears the stored token immediately rather than retrying against
  a server that will never accept it
- the pairing screen has a *back to the feed* link, so opening it by accident
  isn't a dead end

### npm install / rebuild fails, "it thinks it's running"

It was. Two causes, both fixed:

- The window closing didn't end the process. With a tray icon present, Electron
  keeps running with no visible window — so you had an invisible process
  holding its unpacked temp directory, and `npm run build` couldn't overwrite
  `dist\`.
- No single-instance lock, so every launch added another one.

Now closing the window quits, the tray is destroyed on quit, and a second
launch focuses the existing window instead of starting a rival.

**To clear the ones already stuck**, in PowerShell:

```powershell
taskkill /IM "MILF Viewer.exe" /F
taskkill /IM electron.exe /F
```

Then delete `dist\` and rebuild. If `npm install` still fails on
`node_modules`, close any editor with the folder open — VS Code's file watcher
holds handles on Windows.
EOF
mv /tmp/mkrelease.md /dev/null 2>/dev/null; echo written

---

## Never commit node_modules

GitHub Desktop will offer to commit it. Decline. `node_modules/electron/dist/electron.exe`
alone is over 100 MB, which is GitHub's hard per-file limit — and the whole
folder is ~300 MB that gets rebuilt from `package-lock.json` anyway.

**Git LFS is not the answer either.** LFS exists for large files you genuinely
need versioned — art assets, sample data. A dependency you can reinstall in
thirty seconds isn't one, and LFS has its own storage quota you'd be burning
for nothing.

The repo should be about 350 KB:

```
.github/workflows/release.yml
build/icon.ico  build/icon.png
renderer/index.html  renderer/icon.png  renderer/icon-256.png
main.js  preload.js
package.json  package-lock.json
.gitignore  BUILD.md  RELEASING.md  test-viewer.js
```

**Do commit `package-lock.json`.** `npm ci` in the release workflow needs it,
and it's what pins the exact dependency versions your build was tested against.

### If you already committed it

Not yet pushed:

```
git rm -r --cached node_modules dist
git commit -m "stop tracking node_modules and dist"
```

Already pushed: the objects are in history and the clone stays large even after
you delete the files. Either accept it, or rewrite history with
`git filter-repo --path node_modules --invert-paths` and force-push. On a repo
this young with no other contributors, rewriting is painless — do it now rather
than later.
