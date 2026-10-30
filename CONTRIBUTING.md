# Contributing

Start a short-lived branch from current `main`, track the work in an issue and the
GitHub Project, and open a PR targeting `main`. Do not stack branches or PRs. If a
change depends on another PR, wait for that prerequisite to merge, then branch
from updated `main`. Follow [AGENTS.md](AGENTS.md) and the templates in `.github/`.

## Validation

Run checks relevant to the change using the project's Cargo, Bun/Turbo, Vitest,
Playwright, Gradle/JUnit and XCTest tasks. See the [README](README.md#checks).
Report executed, failed and unexecuted checks accurately. Documentation-only
changes do not require native runtime tests; explain inapplicable PR checkboxes.
Do not substitute a passing build for device or behavioral acceptance.

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
