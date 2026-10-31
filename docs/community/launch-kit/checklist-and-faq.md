# Publication checklist and FAQ

## Before any announcement

- Verify the public release URL, platform/architecture, signature/channel and checksums.
- Execute the advertised installation and SSH/reconnect workflow on the stated device.
- Review media against the [capture register](../demonstrations.md); publish only existing, sanitized assets with permission and captions.
- Check every URL and distinguish source targets from installable app availability.
- Resolve critical advertised-workflow blockers or state the concrete limitation prominently.
- Ensure support/private disclosure paths work and a maintainer can answer questions.
- Read current destination rules, disclose authorship, and get maintainer publication approval.
- Record actual publication links and aggregate feedback; never arrange votes, stars or sockpuppets.

## FAQ

**Does lazysh run my AI agent?** No. Agents and long-running sessions run on your
host. The optional companion supplies supported records over SSH.

**Do I need an account?** Direct SSH needs your own server account, not a hosted
lazysh account. Optional integrations have their own configuration requirements.

**How do I install on Android?** Prefer Obtainium with the official GitHub source
and the chosen FOSS/Google ARM64 filter in [the guide](../../install-and-update.md#android).
Manual APK installation is also documented. An APK download is not proof of
native behavior on every device.

**Is iOS available publicly?** No public iOS app distribution is claimed. Apple
source/simulator paths do not establish a normal installable app.

**Is it production-ready?** It is a development preview with platform-specific
acceptance limits. Read the exact release's notes, not just the presence of a tag.

**Where are the screenshots?** The [register](../demonstrations.md) lists missing
evidence until reviewed real capture exists. The logo is not a workflow demo.

**How can I contribute?** Use the [first contribution guide](../first-contribution.md)
and public issues. Maintainers should credit real merged contributions in release
notes; no user endorsements or contributors are invented by this kit.
