# Automated application release preparation

Tracked in #423, with official F-Droid delivery separately in #424/#333. This
GitHub publication is enabled by `.changeset/release-policy.json` for Android,
Linux and Windows. Apple releases are deferred. The #344 acceptance and official
F-Droid submission prerequisites remain pending and do not imply store inclusion.
Missing signing credentials must block installable
mobile artifacts and final publication, with finite diagnostics listing missing
configuration names only. Never substitute a debug APK, ephemeral signing key or
unsigned/simulator IPA.

## One source and one tag authority

Publish the current version once, then every future Changesets version merged
individually to main. There is no historical backfill. Ordinary releases require
the exact main-event SHA, a stable first-parent version/code increase,
synchronized manifests/locks and no pending Changesets. The supported workflow is
one Changesets version merge per main push; arbitrary batch pushes containing
multiple version transitions are not enumerated.

Initial publication is an explicit main `workflow_dispatch` with `initial: true`
and `expected-source-sha` equal to the full event/checkout SHA. The committed
policy allowlists version 0.23.0 and requires its source to follow
`f5cdacea70f313fa216e8963b76effd098340007` in bounded first-parent history.
Only this mode admits an unchanged version and retains pending Changesets for the
next release. It does not consume/discard them or checkout caller-selected source.
A false/malformed selection, mismatched acknowledgement, other version, branch or
push event cannot enable initial publication. Prepare, tag and publish repeat the
same admission. Initial notes include the prepared client version section, root
Unreleased changes. Every release also includes the exact current native
acceptance status section from `docs/install-and-update.md`; missing or ambiguous
status blocks notes generation. Full parity is not claimed.

Both modes build platform assets before the tag job. Only the existing gate
creates `vVERSION`; Android, Linux and Windows receipts are required. The dependent
publication job runs in the same workflow because a tag created with
`GITHUB_TOKEN` does not trigger an ordinary tag-push workflow. Never overwrite a
different existing tag or upload replacement bytes to an existing release.
Per-source concurrency keeps later main pushes from canceling pending version
runs. The final publication request uses `make_latest: legacy`, so latest selection
uses release creation date and semantic version rather than completion order;
see the [GitHub release API](https://docs.github.com/en/rest/releases/releases#update-a-release).

An explicit build-only workflow dispatch may prepare private installation assets
for verification without creating tags/releases or changing policy. It must use
the exact trusted main checkout, not an arbitrary caller-provided ref. All platform
jobs use contents-read permissions; only the final tag/publication jobs may write.
Failed/incomplete builds retain diagnostic receipts and cannot publish.

Immediately before tagging and publishing, the candidate must remain within the
bounded first-parent ancestry of observed main (at most 4097 commits). Newer main
versions do not supersede a verified candidate: each version retains its exact
built source and bytes. Side-branch ancestry and replaced main history fail closed.
No newer source is executed or substituted. The reference check and creation are
separate requests, so a later main update can race the check; the tag still targets
the verified immutable candidate. Failed uploads retain an unpublished draft for
explicit inspection; existing releases are never automatically replaced or replayed.

## Required configuration

Names below describe configuration to provision securely; do not place values in
issues, source, logs or chat. No Actions secrets/variables were configured at the
initial names-only inspection of main51c18d4.

* Android: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`,
  `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_PASSWORD`, `ANDROID_SIGNER_SHA256`:
  durable keystore, alias, store/key passwords and reviewed SHA256
  certificate fingerprint. Preserve and back up this identity outside CI. A
  release must pass `apksigner verify`, exact fingerprint, app ID/version/code and
  non-debuggable checks. Keep normal unsigned F-Droid source builds usable.
* iOS: `APPLE_DEVELOPMENT_TEAM`, `IOS_CERTIFICATE_BASE64`,
  `IOS_CERTIFICATE_PASSWORD`, `IOS_PROFILES_BASE64_JSON`: Apple team and
  distribution signing certificate/private key plus four
  valid release-testing profiles for `app.lazysh.client`, `.liveactivity`,
  `.watchkitapp` and `.watchkitapp.widgets`. Profiles must match the team,
  application groups, entitlements and intended devices. Export and verify the
  actual signed app/extensions; never omit embedded targets to bypass signing.
  The profile secret is a JSON object whose exact four keys are the bundle IDs
  above, with canonical base64 mobileprovision values. Use registered-device
  release-testing profiles, not development or App Store-only profiles. The
  pinned CLI 2.12.4 supports an unsigned archive without export; Xcode then exports
  using all four profiles, followed by signature/identity/profile checks. Source:
  [Tauri CLI 2.12.4](https://github.com/tauri-apps/tauri/blob/993038c49185307dfc895ab7657d77ca0d5ed7c7/crates/tauri-cli/src/mobile/ios/build.rs).
* macOS: ad-hoc signing is a possible explicitly labelled first channel. Developer
  ID signing/notarization needs an owner-provisioned certificate and Apple
  notarization credentials. It cannot be inferred from a successful ad-hoc build.
* Windows: installer signing is optional for a clearly labelled unsigned initial
  channel; a trusted publisher identity requires separate signing credentials.
* Unattended Changesets PR checks: `RELEASE_APP_ID` repository variable and
  `RELEASE_APP_PRIVATE_KEY` secret for a repository-scoped GitHub App installation
  token (or suitable owner-managed token). Default `GITHUB_TOKEN` PRs create
  approval-required runs. Do not introduce an untrusted PR auto-approval runner.
  Grant/install the App only for this repository with contents/pull-requests write.
  The workflow requests those permissions explicitly and uses the installation
  token only for version PR creation/template updates. Missing App configuration
  retains the existing approval-required path and prints that limitation.

## Native build acceptance

First validate release admission and artifact identity/tampering in the existing
Bun release suite. Then execute real Tauri desktop bundling and Android release
packaging against current owned source/isolated targets. Verify package metadata,
APK certificate and every embedded Apple signature/profile. Generate an explicit
artifact manifest and SHA256 list only after these checks. Recheck every digest
after downloading same-run artifacts in the final aggregation/publication job.
No synthetic metadata test establishes native installer or device acceptance.

Windows staging additionally executes the freshly built NSIS installer on its
owned GitHub-hosted Windows VM: silent per-user installation into a fresh job-temp
directory, exact installed executable length/hash/version comparison with the expected NSIS image,
restoration of a deliberately removed executable by same-version reinstallation,
preservation of a unique marker in a newly created application-data directory,
and native uninstall. Missing WebView2, existing lazysh paths/registrations,
reparse points, nonzero exits, timeouts and uncertain cleanup fail closed. Only
owned files, the empty owned data directory and the exact newly owned install
registry key are removed; registry parents and existing user data are not adopted.
The current unsigned Windows channel models exactly the pinned Tauri CLI 2.12.4
bundle transformation: it replaces the unique `__TAURI_BUNDLE_TYPE_VAR_UNK`
constant with `__TAURI_BUNDLE_TYPE_VAR_NSS` before packaging, then restores the raw
Cargo binary. Acceptance streams the raw build to predict that entire packaged
image, binds the raw source hash/length, and compares every installed byte through
its full SHA256 and length. Missing or duplicate unpatched markers, already patched
inputs, a different CLI version and signing transformations fail closed; no PE header or
other byte is ignored or normalized. Signing requires a separately reviewed image
model. See the [pinned bundler patch and restore implementation](https://github.com/tauri-apps/tauri/blob/993038c49185307dfc895ab7657d77ca0d5ed7c7/crates/tauri-bundler/src/bundle.rs).

The installer never launches the app. Windows native PR CI packages NSIS and runs
the same helper through the existing Bun release-artifact test owner with
`LAZYSH_TEST_WINDOWS_INSTALLER=1`; ordinary release-tool suites explicitly skip
that native case. This proves same-version repair, not prior-version upgrade,
application startup, migration or real user-data compatibility. Unsigned-download
SmartScreen behavior and trusted publisher signing remain separate acceptance.
Flags and behavior follow the
[pinned Tauri CLI 2.12.4 NSIS template](https://github.com/tauri-apps/tauri/blob/993038c49185307dfc895ab7657d77ca0d5ed7c7/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
and [NSIS command-line documentation](https://nsis.sourceforge.io/Docs/Chapter3.html).
`/D=` and `_?=` are final raw arguments, including paths containing spaces;
acceptance uses no Windows security-policy or CRC override.

Linux/Windows/macOS architecture coverage and signing status must be listed
per file. Android ARM64 is the existing production target; emulator x86_64 debug
artifacts remain separate. Real device installation/update and Apple distribution
acceptance stay unverified until executed. Installation guidance is in
[install-and-update.md](install-and-update.md).

Automatic publication currently excludes macOS, iOS and watchOS packages. The
explicit private iOS build remains available for later signing verification; it
does not enter the release set. Official F-Droid inclusion remains separate.

## Official references

* [Tauri GitHub distribution](https://v2.tauri.app/distribute/pipelines/github/)
* [Android signing](https://v2.tauri.app/distribute/sign/android/)
* [iOS signing](https://v2.tauri.app/distribute/sign/ios/)
* [GitHub workflow token event behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
* [F-Droid first inclusion](https://f-droid.org/docs/Submitting_to_F-Droid_Quick_Start_Guide/)
* [F-Droid update metadata](https://f-droid.org/docs/Build_Metadata_Reference/)
