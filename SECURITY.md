# Security Policy

## Supported versions

Only the latest stable MILF Viewer release receives security fixes.

| Version                        | Supported |
| ------------------------------ | --------- |
| Latest stable release          | Yes       |
| Older stable releases          | No        |
| `continuous` prerelease builds | No        |

Users should reproduce a suspected issue on the latest stable release when it
is safe to do so. Continuous builds are intended for early testing and can help
confirm a fix, but they are not a supported release line.

## Report a vulnerability privately

Do not disclose suspected vulnerabilities in a public issue, discussion, pull
request, or chat channel. Use GitHub's
[private vulnerability reporting form](https://github.com/MiniLuv-Skunk-Works/miniluv-intel-viewer/security/advisories/new)
instead.

Include as much of the following as is safe and relevant:

- The affected MILF Viewer version and Windows version
- The expected and observed behavior
- Reproduction steps or a minimal proof of concept
- The security impact and realistic attack prerequisites
- Relevant logs with tokens, pairing codes, dashboard data, and personal data removed
- A suggested mitigation or fix, if known

The maintainers will acknowledge the report, investigate it, and coordinate any
fix and disclosure through the private advisory. Response and remediation times
depend on severity, reproducibility, and maintainer availability; this project
does not promise a fixed response SLA.

## Scope

Reports about the viewer's Electron security boundaries, IPC validation,
credential handling, dashboard transport, protocol parsing, clipboard privacy,
release artifacts, or update guidance are in scope. Dashboard or organizational
infrastructure issues should be reported to the owner of that system unless the
viewer itself causes the vulnerability.
