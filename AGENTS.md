# Development workflow

Use trunk-based development.

- Fetch the latest `main` before starting work. Create every work branch and worktree from `main` or `origin/main`.
- Never branch from another feature, fix, or documentation branch. Do not create stacked pull requests.
- Target `main` for every pull request and merge completed work into `main`.
- If a change depends on another change, merge that prerequisite into `main` first, then start the dependent branch from updated `main`.
- Keep branches short-lived. Track work with GitHub issues, the project board, and pull requests.
- Review changes, address findings, and run relevant checks. Once ready, merge autonomously; do not leave a ready pull request open awaiting user confirmation.
- Create every Git worktree under `~/dev/.worktrees/`.

# Issues and pull requests

Use the issue and PR templates in `.github/`, adapted from `akitaonrails/ai-memory`. Keep every required section, state checks accurately, and mark inapplicable checks with a reason. User-facing changes require a `CHANGELOG.md` entry under `[Unreleased]`; call out changed defaults. The templates do not override the trunk-based workflow above.

# Zero duplication

If jscpd detects any duplicates, the pre-commit hook must fail. Refactor duplicated
code with DRY until the repository scan reports zero clones. Do not bypass the
hook, baseline existing clones, relax detection thresholds, or exclude handwritten
source/tests to make it pass. Keep vendor, generated-artifact and legal-notice
scope explicit and preserve third-party attribution. The hook prints this
instruction after every actual run, whether it succeeds or fails.
