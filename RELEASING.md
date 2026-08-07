# Releasing MILF Viewer

GitHub Actions is the only supported publication path. Stable releases are
created from version tags, and pushes to `main` update a separate continuous
prerelease. Do not create or upload a stable release manually in the GitHub UI.

## Stable release procedure

1. Start from a clean branch based on `main`.
2. Update `package.json` and `package-lock.json` to the intended version:

   ```powershell
   npm version <version> --no-git-tag-version
   ```

3. Review both version-file changes and update user-facing release documentation when needed.
4. Run the complete Windows gate:

   ```powershell
   npm ci
   npm run verify
   ```

5. Commit the version change, merge it to `main`, and confirm the `main` workflow succeeds.
6. Tag the merged commit with exactly `v<version>` and push the tag:

   ```powershell
   git tag v<version>
   git push origin v<version>
   ```

The stable workflow fails before packaging if the tag does not equal `v` plus
the `package.json` version or if the tagged commit is not reachable from
`main`. The Windows build/test job has read-only repository access. Separate
no-checkout jobs attest and publish the immutable build payload with only the
permissions their operations require.

## Stable release contents

A successful `v<version>` workflow creates a GitHub release containing:

- `MILF-Viewer-<version>.exe`
- `MILF-Viewer-<version>.exe.sha256`
- `MILF-Viewer-<version>.spdx.json`
- GitHub-hosted build-provenance and SBOM attestations for the executable

GitHub generates release notes from the merged changes. Confirm that the
release is present, all three downloadable assets exist, and the workflow's
attestation jobs completed before sharing it.

## Continuous builds

Every push to `main` also updates the `continuous` prerelease. Pull requests
build and test the same portable executable but only retain it as a 14-day
Actions artifact; pull-request code is never published as a release.

The continuous prerelease replaces these stable-name assets:

- `MILF-Viewer-latest.exe`
- `MILF-Viewer-latest.exe.sha256`

Its permanent executable URL is:

```text
https://github.com/MiniLuv-Skunk-Works/miniluv-intel-viewer/releases/download/continuous/MILF-Viewer-latest.exe
```

Continuous builds are for early testing and are not a supported release line.

## Verify release artifacts

Download the executable and matching `.sha256` file into the same directory.
For a stable release, replace `<version>` below with the downloaded version; for
a continuous build, use `MILF-Viewer-latest.exe`.

```powershell
$download = "MILF-Viewer-<version>.exe"
$expected = ((Get-Content "$download.sha256" -Raw) -split '\s+')[0]
$actual = (Get-FileHash $download -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -cne $expected) { throw "SHA-256 checksum mismatch for $download" }
```

The checksum uses standard `sha256sum` syntax, so Linux and Git Bash users can
instead run:

```text
sha256sum --check MILF-Viewer-<version>.exe.sha256
```

With the GitHub CLI installed, verify the repository, commit, workflow, and
signed dependency statement:

```powershell
gh attestation verify $download --repo MiniLuv-Skunk-Works/miniluv-intel-viewer
gh attestation verify $download `
  --repo MiniLuv-Skunk-Works/miniluv-intel-viewer `
  --predicate-type https://spdx.dev/Document/v2.3
```

Checksums and attestations establish integrity and provenance. They do not
replace Windows Authenticode signing or suppress SmartScreen warnings.

## Signing policy

Releases are currently unsigned. Include a clear SmartScreen note in
user-facing release communication and revisit signing if distribution grows or
organizational policy requires it. Azure Artifact Signing or an open-source
signing service can be evaluated at that time; credentials must remain in
GitHub Actions secrets and never enter the repository.

Do not add automatic executable replacement until a future updater verifies
signed metadata or an equivalent trusted release statement before installing
an artifact.

The viewer's release-awareness panel is not an updater: it checks only the
latest stable GitHub release, renders bounded metadata as plain text, and opens
the allowlisted release page after an explicit user action. It must continue to
avoid downloading, executing, or replacing release artifacts.

## Failed release recovery

Fix the underlying problem on a branch, merge the correction to `main`, and
create a new patch version and tag. Do not move or force-update a published
stable tag. Diagnostics from failed Windows tests are retained under the
workflow run's `MILF-Viewer-test-diagnostics-<commit>` artifact when available.

For local packaging and locked-file problems, follow [BUILD.md](BUILD.md).
