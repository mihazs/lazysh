# Install and update lazysh

Use the signing status and availability recorded for the particular release.
Actions debug APKs and simulator apps are development artifacts, not production
installation downloads. Pipeline activation and outstanding distribution
requirements are tracked separately in #423 and #424.
The automatic application release set targets Android, Linux and Windows. macOS,
iOS and watchOS application packages are deferred and are not included. Future
complete releases also include the separate companion CLI targets below; that does
not enable deferred Apple application packages or claim full native parity.

When a verified release is available, use the assets on the repository's
[Releases page](https://github.com/mihazs/lazysh/releases). Check the version,
operating system, architecture and signing channel against `release.json`, then
verify the download using `SHA256SUMS`. Checksums detect corruption; trust the
repository/release identity as well. Never install a file whose checksum differs.

## Remote companion executables

Releases produced after the companion distribution change include raw executable
assets identified in `release.json` as `linux-agent-x64`, `linux-agent-arm64`,
`macos-agent-x64`, `macos-agent-arm64` and `windows-agent-x64`. Linux binaries use
static musl linkage; this does not change the Linux desktop application's runtime
requirements. macOS binaries are built with deployment targets 10.15 for Intel
and 11.0 for ARM64 and checked on matching macOS 15 runners; those build targets
do not establish execution on every older OS release. Windows uses the x64 MSVC
target. Other architectures need a source build until explicitly supported.

Use the matching version, target, size and SHA256 from the same source-bound
release manifest, and check `SHA256SUMS`. Each companion is capped at 64 MiB. On
Unix, mark the verified file executable before running it; downloads do not
preserve executable mode. Install it only on the intended remote account and
ensure `lazysh-agent` is available on its noninteractive SSH PATH. These artifacts
do not install hooks, enable publishing or change existing companion settings.

Mac companion signatures are ad hoc, not Developer ID signatures or notarization.
Do not disable host security policies to run one. Source SHA/version, content
hashes, native executable identity and an owned CLI/database roundtrip are checked
before release staging. Candidate PR checks run the same byte acceptance but
produce no publication receipt. No Apple account is used by these CLI builds.

Published v0.23.0 remains unchanged and has no companion binary assets; no earlier
version is backfilled. In-app SSH installation is tracked separately in
[issue #476](https://github.com/mihazs/lazysh/issues/476).

## Android

Use the ARM64 release APK for a compatible Android 7.0/API24 or newer device.
The Google and FOSS builds use the same application ID and cannot coexist.
The FOSS build excludes Firebase/GMS; a compatible UnifiedPush distributor and
self-hosted service are separate setup requirements. It must not be described as
complete remote-notification parity while #344 remains open.

Allow installation from the browser/file manager used to open the APK, install,
then turn that permission off if no longer needed. Future APK updates must have
the same application ID and signing certificate; installing over the existing
app preserves its Android application data. Back up/export important data before
updating. Do not uninstall to resolve a signing mismatch without first exporting
data: uninstalling can remove local data and Keystore credentials.

Official F-Droid releases will be installed/updated through F-Droid after first
inclusion is approved. They are built and signed by F-Droid, independently of
GitHub. Do not assume an F-Droid APK can update a developer-signed GitHub APK or
vice versa. Choose one signing channel and follow its migration instructions.
No F-Droid.org listing or automatic update is claimed at present; see #333/#424.

## Linux

Use the Debian package with your package manager, or make the downloaded
AppImage executable and launch it. Match the machine architecture. Updating
replaces the application binary, not its user configuration directory. Retain
backups; do not delete the configuration directory as an update step. AppImages
may require the distribution's FUSE compatibility package. Desktop WebKit and
other runtime dependencies are checked by the native package/build acceptance.

## Windows

Use the x64 installer and keep the existing application/data location when
updating. An unsigned installer can show an unknown-publisher/SmartScreen warning;
unsigned does not establish publisher identity. Only proceed after independently
verifying the source and checksum. A later signed channel must document its
publisher certificate. Never disable system-wide security protection to install.

## macOS

Choose Apple Silicon or Intel as appropriate. Open the DMG and copy the app into
Applications, replacing the previous app while preserving its user data. An
ad-hoc signature is not an Apple Developer ID signature or notarization. macOS
may require an explicit per-app approval in Privacy & Security. Do not disable
Gatekeeper globally or remove quarantine recursively from unrelated files.

## iPhone, iPad and Apple Watch

A simulator bundle or unsigned IPA cannot be installed as a normal release.
An exported release-testing IPA is limited to devices included in its valid
Apple provisioning profiles and expires with those profiles/certificates. It is
not an App Store/TestFlight distribution. Use the documented Apple device
installation tools for an authorized device; preserve backups and the existing
application identity when updating. Watch/Live Activity/widget targets require
their own correctly entitled profiles in addition to the main application.

Public iOS distribution requires a separately configured Apple distribution route,
account and review where applicable. No public iOS installation, automatic OTA
installation or physical-device acceptance is claimed before it is executed.

## Current native acceptance status

The mobile session toolbar now keeps complete buttons in a horizontally scrolling
row, with 44px minimum touch targets. The complete phone/desktop browser suite
passed 426 cases with four inapplicable skips; this is browser layout evidence,
not a physical Samsung/SwiftKey acceptance result.

Attachment uploads use SSH even when the terminal uses Mosh. The real owned
Mosh/OpenSSH check passed an image-sized relative-path upload, reproduced a closed
SSH channel while the UDP terminal stayed live, and uploaded successfully through
a fresh verified connection. The app now explains this condition and the existing
saved-host connection recovery. Restoring that SSH channel inside the original tab
and the Galaxy-specific connection loss remain open in #512. See
[attachment recovery](attachments.md).

Exact public v1.0.0 Google and FOSS signed ARM64 APKs passed native UI host save,
relaunch and identical-byte reinstall with preserved data on admitted translated
ARM64 guests ([qualification](android-published-apk.md#verified-qualification-public-v100)).
This does not qualify later release APKs, cross-version migration or physical
Samsung hardware automatically.

This release does not establish full Android/desktop parity. Owned packaged Android
SSH and guarded Herdr Chat passed on the API36 x86_64 emulator, including native
keep-awake hide/reveal acknowledgement ([runtime evidence](https://github.com/mihazs/lazysh/actions/runs/40894669216/job/123524957621)).
That is scoped emulator evidence, not proof of installing this release's published
ARM64 APK or testing the physical Samsung Galaxy S23+. First-Activity focus/runtime
reliability (#352), SystemUI/ANR startup health (#379), and free-software notification
acceptance (#344/#459) retain their separate outstanding gates.

Linux native GUI acceptance passed all nine owned cases, including authenticated
SSH, exact binary identity and singleton/network isolation ([GUI evidence](https://github.com/mihazs/lazysh/actions/runs/40884642182/job/123489192812)).
Later supported tmux 3.4 execution passed five of six cases; fresh-SSH server
retirement remains unresolved in #7 ([tmux evidence](https://github.com/mihazs/lazysh/actions/runs/40896489309/job/123529437350)). Windows installer checks
cover installation, same-version repair and uninstall; installed GUI acceptance
(#457), version upgrade and data migration remain pending. Concurrent Windows
companion startup has intermittently returned SQLite busy errors
([#36](https://github.com/mihazs/lazysh/issues/36)); this remains under investigation.
Rex compatibility
requires authorized beta access that is not available. Apple distribution is
deferred. These limits remain explicit even when source builds, signatures and
installer checks pass. Consult the linked issues for current acceptance evidence.

## What updates automatically

The release pipeline published 1.0.0 through its reviewed allowlist and an explicit,
source-bound dispatch after the source-recipe correction. Each future individually
merged Changesets version requires verified source builds and installation artifacts. It does not
backfill historical versions or silently replace a running desktop/mobile app.
Every gate rebuilds the exact acknowledged source. The published 0.23.0 remains
immutable; pending Changesets remain for the next version during allowlisted publication.
Use the platform installer or your chosen distribution channel to apply updates.
All lazysh features remain free and open-source; external Apple signing/account
requirements are platform constraints, not a lazysh subscription or feature gate.
