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

The `main-verdict` workflow runs alongside this one on every push to `main`: a combined type or
build break surfaces there within minutes instead of in `source-build`, but the verdict does not
gate the version PR ([Main verdict](../CONTRIBUTING.md#main-verdict)).

Both modes build platform assets before the single publication job. Only the existing gate
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
jobs use contents-read permissions; only the final publication job may write.
In build-only dispatches with `platform: all`, a separate `aggregate` job verifies the
full set and retains it as `verified-release-set`. The release-tag caller aggregates
inside its publication job instead.
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

## Measured release size

Release size is a gate for [#20](https://github.com/mihazs/lazysh/issues/20), measured
from the bytes each published release lists in its `release.json` (the same bytes the
release job verified against `SHA256SUMS`). Sizes below are MiB of the public package
files, read from the GitHub release assets on 2026-11-14.

|Package|v0.23.0|v1.4.1|v1.30.1|v1.62.0|Ceiling|Growth v1.4.1 to v1.62.0|
|---|---:|---:|---:|---:|---:|---:|
|Android FOSS APK (arm64)|29.3|29.8|30.2|30.8|47|+3.4%|
|Android Google APK (arm64)|29.5|30.0|30.7|31.3|78|+4.2%|
|Linux AppImage (x64)|91.8|94.4|94.6|95.0|143|+0.7%|
|Linux deb (x64)|18.4|21.2|21.5|21.9|33|+3.2%|
|Windows installer (x64)|5.2|7.1|7.3|7.6|12|+6.8%|
|Linux x64 companion|n/a|10.6|11.0|11.5|18|+8.5%|
|Linux arm64 companion|n/a|8.7|9.0|9.5|15|+8.6%|
|macOS x64 companion|n/a|9.6|10.0|10.5|16|+9.1%|
|macOS arm64 companion|n/a|8.1|8.4|8.8|14|+8.4%|
|Windows x64 companion|n/a|9.3|9.5|10.0|16|+8.5%|

Reading it: since v1.4.1 every package grew by under 10%. Before that, two one-time
steps happened between v0.23.0 and v1.4.1: the Windows installer grew 37% and the five
companion binaries grew 60% to 140% (Linux x64 6.4 to 10.6 MiB, Windows 3.8 to 9.3 MiB
between v1.2.0 and v1.4.1). The v1.4.1 column is the first release after that step, not
a baseline of any kind.

Each package has a ceiling in `packageBudgetsMiB` in `.changeset/release-artifacts.ts`:
1.5 times its v1.62.0 size, rounded up to a whole MiB. Staging and aggregation both
reject a package above its ceiling (`oversized package`, `malformed package receipt`),
so a release cannot publish a stray debug build or an unstripped binary that doubles a
package. A real dependency or asset that needs more room raises its ceiling in the same
change, with a new measurement in this table. The ceilings are guard rails against
accidents, not a statement of the size users should expect.

The Android Google APK is the one ceiling raised since: the Parakeet runtime (ONNX
Runtime and sherpa-onnx, linked into the Google flavor only by
[#1819](https://github.com/mihazs/lazysh/pull/1819)) grew the release arm64 APK built
for that change to 54,082,206 bytes (51.6 MiB; `liblazysh_lib.so` went from 20,962,712
to 42,219,808 bytes), so its ceiling is 1.5 times that, 78 MiB
([#2212](https://github.com/mihazs/lazysh/issues/2212)). The model is downloaded on
demand and is not in the APK. That figure is the pull request's build, not a published
asset: remeasure it from the first release that ships the runtime. The FOSS APK does
not link the runtime and keeps 47 MiB.

Not measured here, and not claimed: installed size on a device or desktop, download size
over a store or delta update, per-ABI Android splits (the published APKs are arm64
only), and macOS or iOS packages (not published; they keep the 2 GiB bound until a first
published build gives them a measurement). Remeasure a release with
`gh release download vX.Y.Z -p release.json` and read `platforms[].files[].bytes`.

## Bundled companion

Each desktop package carries the `lazysh-agent` of its own platform beside the app,
so a fresh install has a local companion (the local arm resolves it first). The
desktop job does not build it: it downloads the `release-<companion target>`
artifact the same run's `companion` job built, verified and receipted, and
`bun .changeset/release-bundle.ts stage` binds that receipt to this build's commit and
version, requires exactly the receipt's file at its SHA256, and copies it to
`apps/client/src-tauri/binaries/lazysh-agent-<host triple>` (ignored by Git). The Tauri build then reads
`src-tauri/tauri.bundled-agent.conf.json`, whose `bundle.externalBin` entry packages that
file; it is passed with `--config` on release builds only, because Tauri refuses to compile a
crate whose configured sidecar is missing and every ordinary `cargo build`, `cargo test`
and `tauri dev` would then need a staged binary.

| Package | Companion | Where it lands |
| --- | --- | --- |
| `linux-x64` deb | `linux-agent-x64` (static musl) | `/usr/bin/lazysh-agent` |
| `linux-x64` AppImage | `linux-agent-x64` | `usr/bin/lazysh-agent` of the image |
| `windows-x64` NSIS installer | `windows-agent-x64` | `lazysh-agent.exe` beside `lazysh.exe` |
| `macos-arm64` / `macos-x64` app, dmg | `macos-agent-arm64` / `macos-agent-x64` | `Contents/MacOS/lazysh-agent` |

`.changeset/release-platform.ts` then unpacks each package it built and fails the release
when the companion is missing, is not executable or differs from the published one: `dpkg-deb
--extract` for the deb, `--appimage-extract` for the AppImage (no FUSE needed), and the
installed directory during the Windows installer acceptance, which compares length and
SHA256 after the install and again after the same-version repair. The deb and the
installer carry the published bytes exactly. linuxdeploy adds a `RUNPATH` to every
executable in the AppImage's `usr/bin`, so that copy is compared section by section:
every loaded ELF section except `.dynamic` and `.dynstr` must match the published
executable, and a different set of sections or any other changed byte fails. The check
reads the version through the receipt (a companion of another commit or version is refused
before the build starts), not by running the unpacked file. The macOS branch compares the
app's and the dmg's copy with both code signatures removed, because the bundler signs the
whole app; no workflow builds macOS packages yet (they are deferred), and that branch has
not run on Apple hardware.

The measured sizes above predate the bundled companion. Until a release measures the
bundling packages, their ceilings are the 1.5 times ceiling plus the bundled companion's own
ceiling (deb 33 + 18, AppImage 143 + 18, Windows installer 12 + 16 MiB), the most the
companion can add if the package did not compress it. The next release's measurement
replaces them.

Because the desktop builds wait for the companion artifacts, a release's critical path
has three runner-queue entries (companion, desktop, publication) instead of two.

Every `native-desktop` run (a push to `main`, or a pull request that touches the desktop paths) also runs the companion from the packaged app, not only from beside
the test executable. `native-desktop` builds `lazysh-agent` in release mode (`cargo build
--release`), stages it with `bun .changeset/release-bundle.ts stage-built` (the same sidecar
path the release stages; this build has no receipt, since only the release's companion job
is verified), and packages the app with the overlay config. The `companion::local` real-runtime
cases then run with `LAZYSH_TEST_BUNDLE_DIR` naming the directory that holds the packaged
companion, and the local arm must resolve to that file:

* macOS: the cases run against `target/release/bundle/macos/lazysh.app/Contents/MacOS` of the built app
  (`companion::local::tests::real_local_companion_serves_the_board_transcripts_and_settings_without_a_shell`),
  and the same case must fail against a folder that holds no companion.
* Windows: `tests/release-artifacts.test.ts` ("actual installed Windows bundle") installs the NSIS
  installer, repairs it, runs the Windows cases (the board, transcripts and settings case, and
  `real_local_hook_setup_on_windows_is_template_only`) against the install directory, and uninstalls.
  `agent_snapshot` and `agent_transcripts` return parsed JSON for a transcript recorded under
  a temporary `%USERPROFILE%`, and hook setup reports the template-only state. The same cases fail
  against a directory without the companion, and a case that runs no test fails the step.

The Windows step is non-blocking until its first hosted run on `main` passes
([#1853](https://github.com/mihazs/lazysh/issues/1853)); the macOS step blocks. No Windows or
macOS machine is available locally, so the hosted runners are the only place either step runs.

## Runner layout

The release uses as few hosted runners as its acceptance checks allow:

* Android: one `ubuntu-24.04` job builds both flavors with the same toolchains and
  signer. The Google-free `foss` flavor (`--features fdroid`) builds first from
  the pristine checkout, then `google`. The Gradle app build directory is removed
  before each build. Each APK passes the signer, certificate, identity, version and
  non-debuggable checks and is staged before the next build starts. Cargo keeps
  separate artifacts per feature set, so only the shared dependencies are reused.
  Each flavor still uploads its own `release-android-<flavor>-arm64` receipt.
* Companion Linux x64 and arm64 stay on separate runners. The native acceptance
  harness runs the staged executable and its CLI, WAL and installation owners, and
  requires a matching native runner (`process.arch`). Building arm64 on an x64
  runner would not remove the arm64 runner needed for that execution.
* Companion macOS x64 (`macos-15-intel`) and arm64 (`macos-15`) stay separate for
  the same reason. Rosetta would run the x64 binary on the arm64 host's macOS 15, so
  it would not check the binary natively on x64 hardware.
* Desktop Linux and Windows run on different operating systems.

## Release caches

Release jobs restore dependency downloads that main saved. They never save a cache
and never restore build outputs, so every released binary compiles from source.

* Bun: `.github/actions/setup-bun` with `restore-only: 'true'`. Install checks each
  package against `bun.lock` integrity hashes.
* Cargo: `.github/actions/cargo-registry` restores downloaded `.crate` archives,
  the sparse index and git databases. It never restores `target/` or unpacked
  sources. Main companion candidate jobs in `checks.yml` seed this cache for each
  runner OS and architecture after `cargo fetch --locked`, and only on an exact miss.
* Gradle: `.github/actions/android-toolchains` restores dependency jars and wrapper
  distributions. `checks.yml` saves them from main.

Caches are branch-scoped. A pull request's saved entries stay in its own scope, so it
cannot write an entry that a main release restores. Release companion staging no
longer uses `Swatinem/rust-cache`, which also restores `target/`. Pull request and
main candidates still do. The F-Droid source build runs inside the pinned official
buildserver container with its own downloads and gets no injected cache. Release
jobs have no other sha256-pinned tool downloads to cache.

Release Android builds still fetch Gradle dependencies from the network, and a Maven
registry throttle or a lookup that comes back "not found" fails them minutes in. The F-Droid
source build (`fdroid build`) and the Android job's `tauri android build` run through
`.github/scripts/retry-gradle-resolution.sh`, which runs the build up to five times (1, 3, 6
and then 10 minutes apart) when Gradle reports a failed download: a 429 or 5xx, a dropped
connection, a truncated POM, or `Could not find|resolve group:artifact`. It names the attempt
and the reason in the log. A compile, test, lint or dependency-verification failure is returned
at once. The script adds no cache and no `--refresh-dependencies`, so each retry downloads and
verifies exactly like the first run. `buildSrc/settings.gradle.kts` also lets the `kotlin-dsl`
classpath fall back to Maven Central when the plugin portal reports it missing; Gradle moves to
the next repository only on "not found", never on a 429 or 5xx, and the F-Droid scanner rejects
any repository other than the standard ones, so no mirror is added.

Linux/Windows/macOS architecture coverage and signing status must be listed
per file. Android ARM64 is the existing production target; emulator x86_64 debug
artifacts remain separate. Real device installation/update and Apple distribution
acceptance stay unverified until executed. Installation guidance is in
[install-and-update.md](install-and-update.md).

Automatic publication currently excludes macOS, iOS and watchOS packages. The
explicit private iOS build remains available for later signing verification; it
does not enter the release set. Official F-Droid inclusion remains separate.

## Companion assets are an updater contract

Every release publishes 18 assets (14 on v1.50.0, before the managed Herdr): five companion executables
`lazysh-<version>-linux-agent-x64.bin`, `-linux-agent-arm64.bin`,
`-macos-agent-x64.bin`, `-macos-agent-arm64.bin` and `-windows-agent-x64.exe`;
the desktop and Android packages `-linux-x64.deb`, `-linux-x64.AppImage`,
`-windows-x64.exe` and two `-android-*-arm64.apk`; the managed Herdr
`-linux-herdr-x64.bin` and its bundle `-linux-herdr-notices-x64.json`, `.txt` and
`.receipt.json` (see below); and `release.json`,
`SHA256SUMS`, `release-notes.md` and `INSTALL-AND-UPDATE.md`. GitHub reports a
`sha256:` digest for each asset. `release.json` (schema 1) names the tag's commit,
the version and, per target, `files[{name, bytes, sha256}]`.

The app's installer verifies this chain today, and `lazysh-agent update` and the
host bootstrap will verify it on the host ([ADR 0003](architecture/adr-0003-host-side-companion-update.md#trust-model)).
Changing the file-name pattern, the `release.json` schema, the target names or
the 64 MiB companion cap, or publishing a release whose asset digests differ from
`release.json`, therefore breaks every installed companion that updates itself.
Such a change needs a new `schemaVersion` and a release that older updaters can
still read. Releases publish no detached signature or build attestation.

## Managed Herdr assets

The release builds the managed Herdr ([#1758](https://github.com/mihazs/lazysh/issues/1758), under
[#1522](https://github.com/mihazs/lazysh/issues/1522)) in the `herdr` job of `release-artifacts.yml`: the
release profile with `--features lazysh-managed`, on Ubuntu 22.04 (the glibc 2.35 floor), compiled from source with no
restored `target/`. `.changeset/release-herdr.ts stage` then generates the notice inventory, measures the libc floor
with `herdr-release-receipt.sh`, and refuses to stage unless the build receipt, the inventory and the release identity
agree on the exact source commit, the pinned upstream commit and manifest digest, the target and the feature set and
the receipt names the executable's SHA-256. It also checks the ELF header and runs `--version` in a cleared environment.

Two receipts carry the result, so the receipt the companion updater selects stays one file:

* `linux-herdr-x64` lists exactly `lazysh-<version>-linux-herdr-x64.bin` (at most 64 MiB, the cap the host's fetch
  already enforces; no release has measured it yet). `lazysh-companion-release` knows the four closed Herdr targets
  `linux-herdr-x64`, `linux-herdr-arm64`, `macos-herdr-x64` and `macos-herdr-arm64`, but only `linux-herdr-x64` is
  built and listed in `release.json`, so the others stay unavailable.
* `linux-herdr-notices-x64` lists `lazysh-<version>-linux-herdr-notices-x64.json` (the inventory),
  `.txt` (the notices, whose source links name the tag's commit) and `.receipt.json` (the build receipt with the
  executable's SHA-256, source, toolchains and libc floor).

Both enter aggregation, `release.json` and `SHA256SUMS` like every other target. After publication the `publish` job
runs `release-herdr.ts verify-published`: the release must be public, its tag must point at the published commit, and
the downloaded executable and bundle must match `release.json`, GitHub's digests and each other. A failed check fails
the run after the release is public; it never retracts it. The owned acceptance of the executable (#1761) is a
separate step on the released asset; no platform support is claimed by publishing it. The hosted `herdr` job and the
public check run only on a real release; locally both are exercised against fixture executables and a fake release API.

## Official references

* [Tauri GitHub distribution](https://v2.tauri.app/distribute/pipelines/github/)
* [Android signing](https://v2.tauri.app/distribute/sign/android/)
* [iOS signing](https://v2.tauri.app/distribute/sign/ios/)
* [GitHub workflow token event behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
* [F-Droid first inclusion](https://f-droid.org/docs/Submitting_to_F-Droid_Quick_Start_Guide/)
* [F-Droid update metadata](https://f-droid.org/docs/Build_Metadata_Reference/)
