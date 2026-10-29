# Install and update lazysh

Use the signing status and availability recorded for the particular release.
Actions debug APKs and simulator apps are development artifacts, not production
installation downloads. Pipeline activation and outstanding distribution
requirements are tracked separately in #423 and #424.
The automatic release set currently targets Android, Linux and Windows. macOS,
iOS and watchOS release packages are deferred and are not included.

When a verified release is available, use the assets on the repository's
[Releases page](https://github.com/mihazs/lazysh/releases). Check the version,
operating system, architecture and signing channel against `release.json`, then
verify the download using `SHA256SUMS`. Checksums detect corruption; trust the
repository/release identity as well. Never install a file whose checksum differs.

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

This intermediate release does not establish full Android/desktop parity.
Android first-Activity focus and runtime acceptance (#352), SystemUI startup
health (#379), guarded Chat/SSH acceptance (#306), and notification acceptance
(#344/#459) remain outstanding. Actual ARM64 device installation and update
acceptance remains pending; package identity/signature checks do not establish it.
Desktop GUI and SSH acceptance remains tracked in #457/#458. Windows installer
acceptance covers installation, same-version repair and uninstall; it does not
establish a version upgrade or data migration. Apple distribution is deferred.
These gaps remain explicit even when source builds, signatures and installer
checks pass. Consult the linked issues for current acceptance evidence.

## What updates automatically

The release pipeline publishes the current 0.23.0 version through an explicit,
source-bound initial dispatch, then each future individually merged Changesets
version through verified source builds and installation artifacts. It does not
backfill historical versions or silently replace a running desktop/mobile app.
Pending Changesets remain for the next version during initial publication.
Use the platform installer or your chosen distribution channel to apply updates.
All lazysh features remain free and open-source; external Apple signing/account
requirements are platform constraints, not a lazysh subscription or feature gate.
