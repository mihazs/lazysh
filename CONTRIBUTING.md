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
