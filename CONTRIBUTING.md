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
`bun run duplicates:staged` runs the actual index-oriented gate. New clones fail,
including an additional copy of an already baselined clone. Detection uses mild
mode, at least 50 tokens and five lines, with a 1 MiB per-file limit. Authored
code and tests, including Kotlin under `gen/android`, remain covered. Only build
outputs, three vendored dependency trees, lockfiles and the baseline are excluded
explicitly; jscpd also respects Git ignore rules.

The committed baseline records existing duplication rather than accepting a
percentage threshold. Its initial inventory at main `206d7f9` contained 441
sources and 337 clone pairs (including documentation and existing license notices).
Hooks never update it. For an intentional reviewed baseline change, inspect the
clone report, run `bun run duplicates:baseline`, and review the baseline diff in
the PR. Do not baseline new accidental duplication to make a commit pass.

Run `bun run test:hooks` for native Bun/Git integration tests. They create and
remove isolated repositories and linked worktrees under `~/dev/.worktrees/`,
and exercise clean and rejected commits, third-copy detection, partial staging,
restoration, spaced paths, authored Android coverage and hook-install conflicts.
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
No release is published merely by merging a PR.

User-facing changes require an entry under `[Unreleased]` in `CHANGELOG.md`.
Explicitly identify changed defaults. Internal refactors, dead-code removal and
test-only changes are exempt. Pure repository workflow documentation is also
exempt. Review and resolve findings, then merge ready changes autonomously.
