# Security Policy

## Supported versions

Security fixes are applied to the latest release line and to the default branch. Older pre-release builds are not supported unless a release note states otherwise.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting or open a private Security Advisory in this repository's **Security** tab. Include:

- affected version/commit and operating system;
- reproducible steps or a minimal proof of concept;
- expected and observed impact;
- whether real hardware was connected or moved;
- suggested mitigation, if known.

Remove serial numbers, personal paths, captured credentials, signing material, and sensitive device data before sharing. Maintainers should acknowledge a complete report within three business days and provide an initial triage within seven business days; remediation timing depends on severity and safe hardware validation.

## Security and safety boundary

WL1 Studio is a local desktop application. Its allowlist, range checks, session tokens, and WebView policy reduce accidental or malicious command injection, but they do not turn the host computer into a safety controller. A user with OS-level serial access can bypass this application, and a compromised host can interfere with it.

For suspected behavior that can move hardware unexpectedly, disconnect physical power first. Do not reproduce it on an unrestrained robot. Follow [docs/safety.md](docs/safety.md) and report the software issue only after the rig is safe.

The current Legacy WL1 protocol has no authenticated device identity, capability handshake, or command acknowledgement. This limitation is tracked in [docs/security-audit.md](docs/security-audit.md).
