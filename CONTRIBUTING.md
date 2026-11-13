# Contributing

Start a short-lived branch from current `main`, track the work in an issue and the
GitHub Project, and open a PR targeting `main`. Do not stack branches or PRs. If a
change depends on another PR, wait for that prerequisite to merge, then branch
from updated `main`. Follow [AGENTS.md](AGENTS.md) and the templates in `.github/`.

## Contribution paths

**First contributions:** documentation, translations, bug reproduction, focused
tests, and small accessibility or UI fixes. Start with the
[first contribution walkthrough](docs/community/first-contribution.md).

**Advanced contributions:** Rust/Tauri internals, SSH and transport ownership,
Android/iOS integration, companion lifecycle and security-sensitive changes.
Coordinate scope and native acceptance with maintainers before implementation.
Both paths use the same review and security requirements. The
[public delivery epic](https://github.com/mihazs/lazysh/issues/1) and linked issues
are available without private project membership. Maintainers track board state;
external contributors do not need access to submit a PR.

## Contributor recognition

Release notes should link merged external PRs and credit their actual authors,
including first contributions when verified from public history. Preserve Git
authorship and third-party notices. Do not infer contributors from stars or
include unverified testimonials. The maintainer preparing a release owns this check.

## Validation

Run checks relevant to the change using the project's Cargo, Bun, moon, Vitest,
Playwright, Gradle/JUnit and XCTest tasks. See the [README](README.md#checks).
Report executed, failed and unexecuted checks accurately. Documentation-only
changes do not require native runtime tests; explain inapplicable PR checkboxes.
Do not substitute a passing build for device or behavioral acceptance.

### Task runner (moon)

[moon](https://moonrepo.dev) orchestrates the Bun and Cargo workspaces as one project graph; the root
`bun run` scripts are thin aliases for `moon run`. `bun install --frozen-lockfile` installs the pinned CLI.

```sh
bunx moon run client:check              # one task      bunx moon run :lint    # one task everywhere
bunx moon task client:build --json      # what moon resolved: command, env, deps, options
bunx moon query projects                # the project graph (tags, layers, dependsOn)
bunx moon ci -g client:check            # only what the diff affects, plus dependents
```

Conventions:

- Every `apps/*` and `packages/*` project has a `moon.yml` with `language`, `layer`, `stack` and `tags`.
  Cargo workspace members carry the `cargo` tag and inherit `check-rust`, `test-rust`, `lint` and
  `format-check` from `.moon/tasks/cargo.yml`; `companion` selects the crates the `agent` CI job verifies.
- moon reads Cargo `[dependencies]` and `package.json` workspace dependencies. It does not read
  `[target.'cfg(..)'.dependencies]` or `[patch]`, so declare those in `dependsOn`.
  `tests/moon-graph.test.ts` fails when a Cargo path dependency is missing from the graph.
- Task ids use `-` where script names used `:` (`test-android-ssh`). Do not set `runInCI: false` on a task a workflow runs: `moon run` skips such a task when `CI` is set.
  Workflows always pass explicit targets to `moon ci`/`moon run`; never run `moon ci` unfiltered, since that selects the
  device, simulator and browser tasks too.
- moon does not filter the environment, so every task sees the whole process environment. A task `env` constant
  loses to a conflicting process value unless the task sets `options.envOverride: true`; use it for flags such
  as `LAZYSH_ANDROID_UI_QR=1`.
- Most tasks are uncached; only `client:check`, `client:test` and `client:check-native-gui` are cached.
  There is no remote cache.

The tables are in the [moon task reference](docs/reference/moon-tasks.md) and the procedures in
[Run tasks with moon](docs/how-to/run-tasks-with-moon.md).

### Which CI jobs a pull request runs

`client` and `agent` always run. On a pull request, the `changes` job runs
`.github/scripts/native-changes.sh` over the PR range and then a fast gate (rustfmt,
hook and CI structure tests, client type check); every native job waits for it, so a
PR that fails the gate never queues emulator, macOS or Windows work. Pushes to `main`
skip the gate and run every job with the full matrix, which is the parity evidence.

| Changed paths | Native jobs on the pull request |
| --- | --- |
| Documentation only (`docs/**`, root `*.md`, `.changeset/*.md`, issue and PR templates) | none |
| Client: `apps/client/**`, `apps/share-service/**`, client-only packages | Herdr, Linux GUI, Linux runtimes, desktop (macOS, Windows), Android build, Android runtime, Android tmux |
| Agent: `apps/agent/**`, `packages/{common,account-usage,notification-client}`, notification service | companion candidates (5), Herdr, Linux GUI, desktop, Android runtime, Herdr navigation, Android auxiliary; the notification service and client also run Linux runtimes (real Apprise API) and both ntfy variants |
| Android: `gen/android/**`, plugin `android*/` source sets, Android tests | Herdr, Android build, runtime, Herdr navigation, tmux, auxiliary, ntfy (Google) |
| iOS: `src-tauri/apple/**`, plugin `ios/` source sets, Apple packages, client configuration shared with iOS | iOS simulator (plus the client set when client code changes) |
| Herdr: `packages/herdr-{upstream,guard}/**` | Herdr and its Linux GUI, Linux runtime, Android runtime and Herdr navigation consumers |
| Terminal runtime and renderer: `packages/terminal-{runtime,renderer-wgpu}/**` | Herdr only: their tests run in that job against the same libghostty-vt build (the renderer's on Mesa software Vulkan) |
| Mosh transport, push registration | the client set plus iOS, and Android Mosh or Android auxiliary and both ntfy variants respectively |
| Workflows, `.github/scripts` or `.github/actions`, manifests, lockfiles, release tooling, any unlisted path | everything, with both ntfy variants |

Matrices fail fast on pull requests and keep every verdict on `main`. The script and
`tests/native-changes.test.ts` are the exact mapping; extend both when a job gains a
new input, and map an uncertain path to more jobs, never fewer.

### Main verdict

Two pull requests can each pass `checks` and still break `main` together (the v1.49.0 release failed
`source-build` when both added the same i18n keys). `checks` and `version` share one concurrency group
per ref, and GitHub keeps one running and one pending run per group, so on a busy trunk the run of an
older merge commit is cancelled while pending and never reports. The `main-verdict` workflow closes
that gap: every push to `main` gets its own run (group `main-verdict-<sha>`, never cancelled) of three
parallel jobs, `verdict-client` (`moon run client:build`, which is `tsc -b && vite build`),
`verdict-agent` (`moon run '#companion:check-rust'`) and `verdict-release-tools` (`bun run test:release`).
It completes within minutes, runs no native, emulator or end-to-end job, and its check names differ
from the required `client`, `agent` and `release-tools` jobs on purpose: it is not a required status
check, because it only runs after the merge. `tests/main-verdict.test.ts` pins this behavior.

A red verdict means `main` is broken: fix forward with a PR that restores a green `tsc -b`, and do not
merge the version PR until the verdict of the new tip is green. **Merge procedure for the version PR
(`chore(release): version lazysh packages`):** besides its own `release-tools` check, the
`main-verdict` run for its base commit must have completed with all three jobs green. The base commit
is the `main` tip the PR was generated from, and it must still be the tip (the `version` workflow
regenerates the PR after every push to `main`). Check it with
`gh run list --workflow main-verdict.yml --commit "$(git rev-parse origin/main)"`. A running verdict
is not green: wait for it.

GitHub's merge queue was evaluated as the alternative and is not enabled. A queue tests every pull
request on top of the queued commits, which closes the gap before the merge instead of after it, but
it needs a ruleset change and a `merge_group` trigger on every required workflow, and it would run the
full native matrix (Android emulators, macOS, Windows, iOS simulator on a few hosted runners) once per
queue entry, serially. Merge latency would move from minutes to hours, and each known flake ejects an
entry and requeues the ones behind it. "Require branches to be up to date" has the same cost per pull
request. `main-verdict` detects the same class of break within minutes and gates the release, so the
queue stays an option to revisit if post-merge breaks recur; it would then run only the fast verdict
set on `merge_group`.

## Conventional Commits

Every commit and PR title must follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
as described in [AGENTS.md](AGENTS.md#naming). `bun run hooks:install` also enables
`.githooks/commit-msg`, which rejects a non-conforming header before the commit is
created. The `conventional-commits` workflow checks the PR title, which becomes the
squash commit on `main`, and every commit headline in the PR. Sync a branch with
`main` by rebasing; merge commits and Git's default `Revert "..."` headers fail the
check, so write `revert: ...` instead. Validate a header manually with
`sh .githooks/commit-msg --header 'fix(ssh): preserve the host binding'`.

## Pre-commit duplicate detection

After `bun install --frozen-lockfile`, run `bun run hooks:install` to enable the
versioned Git hook. This explicitly sets the repository-local `core.hooksPath`
to `.githooks`, including all linked worktrees; dependency installation does not
activate hooks. The installer refuses to replace a different hooks path or bypass
an existing default pre-commit hook. Integrate existing hooks explicitly instead.

The hook uses pinned jscpd and lint-staged, executed with Bun. lint-staged
`--hide-all` temporarily hides unstaged tracked and untracked changes, so the
whole-repository scan compares the index with unchanged source. Its native Git
backup/restore preserves partial staging; ignored dependencies stay in place.
Git and Bun must be available in the committing environment. See lint-staged's
reported backup stash recovery instructions if an interrupted run needs recovery.

`bun run duplicates:check` scans the current working tree without changing it;
`bun run duplicates:staged` runs the actual index-oriented gate. Any detected
clone fails: duplication must be zero, including pre-existing duplicates.
Detection uses mild mode, at least 50 tokens and five lines, with the native
`1mb` per-file limit. Authored
code and tests, including Kotlin under `gen/android`, remain covered. Only build
outputs, three vendored dependency trees and lockfiles are excluded
explicitly; jscpd also respects Git ignore rules.

Refactor duplicated code with DRY until jscpd reports zero clones. Do not bypass
the hook, add a baseline, relax detection thresholds, or hide handwritten code
or tests to make it pass. Preserve third-party attribution and keep vendor,
generated-artifact and legal-notice scope explicit. The hook prints this
instruction after both successful and failed runs, preserving its command's exit
status. Installation alone does not print the post-run instruction.

Run `bun run test:hooks` for native Bun/Git integration tests. They create and
remove isolated repositories and linked worktrees under `~/dev/.worktrees/`,
and exercise clean and rejected commits, existing-clone rejection even with a
baseline present, partial staging, restoration, spaced paths, authored Android
coverage, exact failure status, instruction output and hook-install conflicts.
These checks run in the Linux client CI job; other committing platforms have not
been runtime-verified by this fixture.

## Commit attribution

Inspect author and committer identity on every PR commit before requesting merge.
Use the intended contributor's configured identity. Correct unintended identity
before publication; never attribute another person's work to yourself. Preserve
third-party authorship and license notices when importing code or templates.

## Versioning and deprecation policy

Select one release impact in the PR: patch for a fix without new surface, minor
for additive behavior, or major for a breaking format, API or removed surface.
All changes target `main`; release impact does not select a different branch.
Breaking changes must explain migration and compatibility in the PR and changelog.
Every completed milestone must lead to a version release. An implementation merge,
Changeset, version bump or tag alone does not finish delivery: merge the reviewed
version PR, wait for verified GitHub publication, and check the public release and
all expected assets. Record that release URL on the milestone's issue and project
card before reporting it released. Publish every current and future version;
historical versions are not backfilled.

Internal/test-only milestones still need at least a patch Changeset when no other
release bump covers them. Empty fragments are suitable only for follow-up work
covered by a planned release; an empty-only plan cannot deliver a milestone.

Add a Changesets fragment with `bun run changeset` for the selected release
impact, alongside the required root changelog entry below. The private workspace
packages release together; generated package changelogs and synchronized
Bun/Cargo/Tauri versions are prepared in a separate reviewed release PR. See
[versioning and milestone releases](docs/versioning.md) for tooling, native version
inheritance and the GitHub PR-creation/CI-approval prerequisites. This does not
configure registry or application-store publishing.

User-facing changes require an entry under `[Unreleased]` in `CHANGELOG.md`.
Explicitly identify changed defaults. Internal refactors, dead-code removal and
test-only changes are exempt. Pure repository workflow documentation is also
exempt. Review and resolve findings, then merge ready changes autonomously.

The code scan retains the existing vendored/build exclusions and excludes
`packages/parakeet-runtime/licenses/**`: upstream legal text must remain verbatim.
The unchanged upstream deep-link `xdg_commands.rs` and `xdg_unregister.rs` tests
are also explicitly excluded; authored deep-link code and regression tests remain
in scope. Authored source and tests have no duplication baseline or allowance.

The AI account collectors retain 201 unchanged MIT-licensed upstream files under
`packages/ai-usagebar-vendor/`, pinned and hashed in `UPSTREAM_FILES.json`.
Only those exact source/legal paths are excluded from duplication scanning.
Adapted headless extraction files and all first-party quota collection,
normalization, process ownership, tests and UI remain scanned without a baseline.
The unchanged Apache 2.0 license at
`packages/account-usage/licenses/HERDR-APACHE-2.0.txt` is also a legal-text
exclusion; the adapted suspended-start process code remains scanned.
