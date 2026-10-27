# Versioning without publishing

lazysh uses Changesets 3.0.3 under Bun 1.3.14 to prepare reviewed version PRs.
All 15 owned private workspace packages form one fixed release group. Their
generated package changelogs describe each release. This does not publish to a
registry, distribute installers, create tags, or submit an application to a store.

For a user-facing change, keep the required root `CHANGELOG.md` `[Unreleased]`
entry, including changed defaults, and run `bun run changeset` to add a fragment
with the appropriate patch, minor or major impact. Select an affected owned
package; the fixed group releases together. Existing root history and
`[Unreleased]` entries are retained verbatim by versioning, not automatically
retrospectively converted into fragments. Generated package changelogs begin
with the first consumed fragment. Internal/test-only changes can use an empty
changeset (`bun run changeset --empty`). No registry configuration is needed.
An empty-only plan does not create a version PR: fragments remain until a real
release fragment arrives, and the workflow checks planned releases rather than
the number of fragment files.

The existing PR release-impact selection and review still apply. All work starts
from and targets `main`; the generated `changeset-release/main` branch is reset
from current `main` when the action prepares the next release PR. It is not a
stacked feature branch. Merging an ordinary PR does not publish a release.

## Version authority

Changesets updates the private Bun package versions. `bun run release:version`
then uses Bun's native `pm version --no-git-tag-version` for the root tooling
package and **cargo-edit 0.13.8** `cargo set-version --workspace` for the Rust
workspace version and lockfile. All owned Cargo packages inherit that workspace
version. Vendored `portable-pty` and deep-link versions remain independent.
The App's About action and About description read the same client manifest
version at build time; their translated labels do not embed an independent
version or request it asynchronously from native code.

Bun 1.3.14 leaves version-only workspace entries in `bun.lock` stale even after
ordinary install or `--lockfile-only --force`. The maintained
`.changeset/bun-lock.ts` compatibility module validates exact owned paths/names,
stable synchronized manifest/native-lock versions and the supported Bun lock
schema before editing only existing workspace-version strings. It retains all
other lock text byte-for-byte, including resolved external dependencies, and
fails closed on unexpected metadata/layout. It neither deletes nor regenerates
the lockfile, installs packages, or resolves dependency versions. Repeated
synchronization with the same version leaves the file unchanged.

Tauri's base config uses its supported `version: "../package.json"` facility.
The actual locked CLI 2.12.4 resolves that path relative to the config directory,
so its parsed config contains the same synchronized client semver. The strict
release gate permits only this exact base path and rejects platform config
version overrides; Cargo packages still inherit the Rust workspace authority.
Desktop Cargo fallback alone does not populate the mobile config: Android would
omit version properties and Apple would default to `1.0.0`. An independently
inspected pre-fix compiled APK reported `versionName=1.0` / `versionCode=1`.
Android's tracked Gradle source reads the generated
`tauri.android.versionName`/`versionCode` properties. The canonical Apple
XcodeGen template already uses Tauri's `apple.bundle-version-short` and
`apple.bundle-version` for the app, Live Activity, Watch app/widget and privacy
bundles. Those expressions and application identifiers are preserved. Build
numbers and store-specific release requirements are not configured here.

Install the native editor explicitly before a local version operation:

```sh
cargo install cargo-edit --version 0.13.8 --locked --no-default-features --features set-version --root "$HOME/.cache/lazysh-release-tools"
export PATH="$HOME/.cache/lazysh-release-tools/bin:$PATH"
bun install --frozen-lockfile
bun run release:check
bun run test:release
```

`release:version` is a checkout mutation, so run it in a clean disposable
main-based worktree or let the release workflow run it. It deliberately fails
when no fragments remain or initial versions disagree. If a later command
fails, it does not publish or roll back files: inspect the failure and recreate
the release worktree from main instead of repeatedly applying a partial plan.
Version mutations run directly, outside Turbo's task cache. The installed Turbo
documentation requires uncached treatment for tasks with external side effects.

## GitHub prerequisites and review

The `version` workflow validates the real-tool fixtures on PRs and main. Its
separate main-only write job uses the **version-only** Changesets action pinned
to v2.1.2's immutable commit. There is no publish action, publish script, registry
token, App token or PAT. The generated PR body is replaced with the repository's
release review template so it does not claim that merging publishes packages.
Reviewers must record applicable checks and the highest consumed release impact.

On 2026-10-26, the repository administrator enabled **Settings → Actions →
General → Workflow permissions → Allow GitHub Actions to create and approve
pull requests**. API readback confirmed `can_approve_pull_request_reviews: true`
and retained `default_workflow_permissions: read`; main rules were unchanged.
The PR-creation field was `false` during initial implementation discovery.
Other installations must enable that setting explicitly and retain default read
permissions. This setup change does not establish hosted release-PR acceptance.
The workflow itself
requests `contents: write` and `pull-requests: write` only for its main-only
version job. It never approves a review or merges its own PR. This repository
setting is a separate administrator prerequisite, not changed by installing the code.

The pinned version action commits through GitHub's API, which does not execute
local Git hooks. Its supported version command calls `bun run release:prepare`,
which runs the repository's strict `duplicates:check` after generation and
before the action can commit or push. The compound operation lives in the Bun
package script because the action tokenizes its command without a shell. Any
detected clone fails the job; no scope exception or threshold change
is made for authored fragments, source or tests.

Current GitHub documentation says PRs opened or synchronized by `GITHUB_TOKEN`
create approval-required workflow runs. A writer must choose **Approve workflows
to run** and review the exact generated head. Token-created pushes do not
automatically create push workflow runs. The Changesets guide still describes
the older suppressed-PR behavior; do not promise unattended CI. If a hosted run
does not appear, inspect that repository's event/approval behavior before
merging. App/PAT setup is outside this workflow.

## Verification boundaries

The standard Bun integration tests execute Changesets, Bun's version/install
commands, cargo-edit, Cargo metadata and a tiny owned Rust client build. On Linux
the installed Tauri CLI bundles that fixture into a Debian package and its
version is read back from its control archive with `ar` and `tar`. These are real local tools, not application
store uploads or production application builds. A Linux Android-SDK fixture
also invokes the actual CLI with a deliberately failing supported
`beforeBuildCommand: "false"`: it must report that exact hook failure and leave
the expected manifest-derived `tauri.android.versionName` and semver-derived
code in its generated properties, proving generation happened before the
intentional compilation stop. This is not a successful APK build. The case is
explicitly skipped without Linux, `ANDROID_HOME`, `NDK_HOME` (or
`ANDROID_NDK_HOME`) and `JAVA_HOME`. Apple mobile effective-version handling is
separately traced in the pinned CLI and its checksum-verified cargo-mobile2
dependency; it consumes the parsed config's version. Actual macOS,
iOS and Android packaging/version acceptance require their native SDK jobs.
The iOS job records the already-built simulator app's public identifier,
short version and build version in a bounded compiled-app-version.json receipt,
alongside a path-free SHA256 of the same compiled plist snapshot. The existing
lazysh-ios-signing artifact retains it before runtime checks and the later app
acceptance artifact includes it again. A missing, malformed, oversized or
unsupported value records an explicit unavailable status and a fixed failure
stage (input, snapshot, identifier, short-version, build-version, validation or
publication), without retaining raw errors, private paths or additional values.
The three scalar fields use `plutil -extract ... raw -expect string -n`; bounded
private files preserve their exact bytes for validation without shell trimming.
The unavailable receipt observed in #241 did not identify its failing stage and
does not establish that scalar JSON extraction caused that outcome. These
observations do not change the
build or test verdict. This app-only observation does not certify embedded
extension/watch versions or physical runtime behavior; native version acceptance
requires inspecting a retained receipt from the exact hosted source/job.
Hosted release-PR creation and default-token CI approval were observed in #220.
Completion also requires correct effective native versions, reviewed checks and
a normal merge; #215 tracks that acceptance and current evidence. These steps
still do not publish packages, installers, tags or store submissions.

Primary references: [Changesets configuration](https://changesets.dev/guide/config),
[non-npm packages](https://changesets.dev/guide/beyond-npm),
[version-only action](https://github.com/changesets/action/blob/v2.1.2/version/README.md),
[Tauri version resolution](https://v2.tauri.app/reference/config/#version),
[Cargo workspace inheritance](https://doc.rust-lang.org/cargo/reference/workspaces.html#the-package-table),
[cargo-edit](https://github.com/killercup/cargo-edit), and
[GitHub workflow token events](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
