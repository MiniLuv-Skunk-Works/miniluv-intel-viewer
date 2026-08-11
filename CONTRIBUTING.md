# Contributing to MILF Viewer

Contributions are welcome. Keep changes focused, preserve the viewer's security
boundaries, and include enough evidence for reviewers to verify behavior.

## Development setup

Development and packaging are supported on Windows 10 or later with Node.js
22.x and npm. Electron bundles a different Node.js runtime for the packaged
application; use the version declared by `package.json` for repository work.

From a clean checkout:

```powershell
npm ci
npm start
```

See [BUILD.md](docs/BUILD.md) for loopback development, packaging, automated tests,
and the manual Windows smoke-test procedure.

## Propose a change

1. Open an issue before starting a large feature, protocol change, or design change.
2. Create a focused topic branch from `main`.
3. Keep behavior changes separate from broad refactors when practical.
4. Add or update tests for changed behavior and update documentation for user-visible or maintainer-visible changes.
5. Run the relevant tests while developing, then run `npm run verify` before requesting review.
6. Open a pull request against `main` that explains the problem, approach, security impact, and verification performed.

The dashboard remains the wire-protocol source of truth. Additive fields and
capability-gated optional behavior should preserve independent releases. A
semantic break requires a protocol-version increase and a coordinated dashboard
and viewer release; unsupported older and future versions must fail explicitly
instead of silently falling back. Portable fixtures should catch drift without
making the public viewer depend on private dashboard packages.

## Generated and sensitive files

Do not commit `node_modules\`, `.build\`, `dist\`, `output\`, local settings,
credentials, pairing codes, dashboard data, or test artifacts containing private
intel. `package-lock.json` is source-controlled and must be updated when package
metadata or dependencies change.

Report suspected vulnerabilities through the private process in
[SECURITY.md](SECURITY.md), not through a public issue or pull request.

## License

By submitting a contribution, you agree that it may be distributed under the
repository's [MIT License](LICENSE).
