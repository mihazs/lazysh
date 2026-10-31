# Growth and community audit

Snapshot: **2026-10-31**, main `70a1e73c8eec06d88fd9d1d66f784c22de8db84e`.
Evidence is repository source, public issue/PR/release API reads, and the primary
references below. Repository work and device execution are different evidence.

## Ranked gaps

| Priority / area | Verified initial finding | User impact | Cost / dependency | Action |
| --- | --- | --- | --- | --- |
| P0 Discoverability / positioning | README explains direct SSH, host persistence and optional agent records; first CTA is source-only and says no installers | High: visitors miss an existing preview | Small; reuse #640/#641 | Correct downloads, preserve maturity warnings; add preferred Obtainium route |
| P0 Installation | v1.3.3 lists FOSS/Google ARM64 APKs, Linux x64 AppImage/deb and Windows x64 installer | High: guide must distinguish actual assets and signing channels | Small docs; native device needed for new activation evidence | Document flavor filters and checksum steps without asserting Obtainium runtime acceptance |
| P0 First-user experience | #576, #352, #379 and #639 track Android readiness/layout failures; #632 explicitly held | High: trust and activation remain gated | Native SDK/device and exact source qualification | Link existing work; do not create duplicate fixes or weaken gates |
| P0 Visual demonstration | Brand kit exists; no reviewed workflow screenshots/video found in public presentation paths | High: no visual proof of the intended workflow | Device and sanitized host | Capture register and repeatable procedure; do not fabricate media |
| P0 Public roadmap | docs/roadmap.md points first to a private board; public #1 links feature issues | High for outside contributors | Small; #641 already owns correction | Use public issues without revealing private notes |
| P1 Release trust | release workflows, SHA256 manifests, signature/channel guidance and scoped acceptance notes exist | High: capabilities differ by platform | Existing release gates; #632 held | Keep signing and native qualification intact; no Apple availability claim |
| P1 Community health | No root support, security or conduct file; existing bug/feature/PR templates retain provenance; Discussions disabled | Medium: support/disclosure routing unclear | Small docs; admin configuration for private reports/Discussions | Add policy entry points, conditional private reporting and exact setup checklist |
| P1 Contributor onboarding | CONTRIBUTING preserves strict gates but lacks beginner walkthrough | Medium: first contribution requires interpretation | Small docs; issue curation | Add two contribution paths and bounded starter tasks |
| P1 Documentation discovery | Many focused guides, no community index | Medium | Small | Add index and cross-links |
| P1 Website | No homepage URL, Pages disabled; shared app index is not a product website | Medium | Static artifact possible; hosting choice unconfigured | Keep repository-first; prepare lightweight local landing artifact without analytics |
| P2 Growth measurement | No weekly scorecard found; API snapshot has 1 star / 0 forks | Medium; stars do not establish adoption | Small; Traffic needs permitted access | Capture aggregate snapshots weekly; unavailable stays unavailable |

The 1-star/0-fork values are a dated API observation, not a usage baseline or
forecast. Traffic, active users, installations and retention were not measured.

## Source and release boundaries

[v1.3.3](https://github.com/mihazs/lazysh/releases/tag/v1.3.3) has 14 assets,
including raw companion binaries for five targets. Apple companion binaries do
not establish macOS/iOS application distribution. The downloaded `release.json` declares Android APKs signed, Linux/Windows apps
unsigned and macOS companions ad-hoc signed, all bound to source
`fd1f718b8947bee31f748c758b769baa4ca535f4`. These are manifest declarations,
not independent binary-signature verification or device installation. Existing native
acceptance is detailed in [install/update](../install-and-update.md) and
[#20](https://github.com/mihazs/lazysh/issues/20).

[#641](https://github.com/mihazs/lazysh/pull/641) already addresses README availability
and public links. [#632](https://github.com/mihazs/lazysh/pull/632) is held pending
source-bound native qualification; do not merge unrelated work into its frozen
source cut or claim a new release. Android, F-Droid and iOS work remains in
[#576](https://github.com/mihazs/lazysh/issues/576),
[#424](https://github.com/mihazs/lazysh/issues/424) and
[#388](https://github.com/mihazs/lazysh/issues/388), among the linked public gates.

## Comparable tools: documentation evidence, not acceptance tests

No competitor binaries were executed. Product-maintained technical docs are used
only to identify documented workflows and documentation patterns, not to validate
marketing claims, superiority, adoption, safety or user satisfaction.

| Tool / primary technical source | Documented approach | Applicable documentation lesson |
| --- | --- | --- |
| [Moshi connections](https://getmoshi.app/docs/connections) | Connection/authentication reference includes SSH, Mosh and ET | Keep trust and transport limits next to connection instructions |
| [Termish README](https://github.com/farlume/termish) | Documents direct SSH/Mosh, a Herdr terminal path and separate optional native agent chat | Separate terminal persistence from optional agent interfaces, and disclose download/build routes |
| [VibeTunnel README](https://github.com/amantus-ai/vibetunnel) | Browser terminal forwarding through its server, macOS app and npm route | Explain client versus host/server requirements before install steps |
| [ConnectBot source](https://github.com/connectbot/connectbot) and [guides](https://connectbot.org/guides/) | Android SSH workflow with dedicated first-host and install-verification guides | Give beginners a focused fingerprint and first-connection path |

The Termish public page was inspected but promotional claims are excluded from
technical conclusions. These observations justify clearer documentation, not new
architecture or a promise of competitor parity.

## Primary references and maintenance

- [Obtainium source documentation](https://wiki.obtainium.imranr.dev/sources/): GitHub source, APK filter and release selection.
- [GitHub community profiles](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories): community files and contribution entry points.
- [GitHub private reporting configuration](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository): administrative prerequisite, not presumed enabled.
- [GitHub Traffic](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository): 14-day visitor history and UTC aggregation.

Maintainers refresh this snapshot after public releases and monthly during the
initial 90 days. Link changed claims to source/issue/release evidence and record
what was actually executed. See [setup actions](maintainer-setup.md) and the
[measurement process](scorecard.md).
