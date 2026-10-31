# Security policy

lazysh is a development preview, not a security-audited production guarantee.
Use the latest published version's notes and outstanding acceptance limits in
[installation guidance](docs/install-and-update.md); no long-term security support
window is currently promised for older versions.

## Reporting a vulnerability

Do not disclose exploit details, private hosts, credentials or transcripts in a
public issue. Check the repository's
[Security advisories page](https://github.com/mihazs/lazysh/security/advisories).
If **Report a vulnerability** is available, use that private GitHub form with the
affected version, impact, minimal reproduction using an owned test host, and
suggested mitigation. Do not include real secrets even in a private report.

Private reporting enablement has not been verified by this documentation change.
If that button is unavailable, open only a minimal public request asking the
maintainer to enable private vulnerability reporting, without vulnerability
details. Wait for a verified private channel before sending sensitive evidence.
No security email address or response-time guarantee is asserted here.

## Connection and distribution boundaries

Verify full SSH host-key fingerprints independently before accepting a host.
Changed keys must be investigated. Follow [credential guidance](docs/credentials.md)
and the release's signing/channel disclosures; a checksum alone is not publisher
authentication. The optional companion runs on your host through your SSH access.
Report issues against hosts and accounts you own or are authorized to test.
