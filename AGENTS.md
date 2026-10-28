# Development workflow

Use trunk-based development.

- Fetch the latest `main` before starting work. Create every work branch and worktree from `main` or `origin/main`.
- Never branch from another feature, fix, or documentation branch. Do not create stacked pull requests.
- Target `main` for every pull request and merge completed work into `main`.
- If a change depends on another change, merge that prerequisite into `main` first, then start the dependent branch from updated `main`.
- Keep branches short-lived. Track work with GitHub issues, the project board, and pull requests.
- Review changes, address findings, and run relevant checks. Once ready, merge autonomously; do not leave a ready pull request open awaiting user confirmation.
- Create every Git worktree under `~/dev/.worktrees/`.

# Naming

- Commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `<type>[optional scope][!]: <description>`. Use a nonempty description and one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`. Examples: `fix(ssh): preserve the original host binding`, `docs: clarify setup`, and `feat(sync)!: change the export format`. Include a breaking-change explanation when using `!` or a `BREAKING CHANGE:` footer.
- Name new human work branches `<type>/<short-kebab-case-description>`, using the same type list and lowercase ASCII words separated by single hyphens. Examples: `feat/zellij-tab-quick-access`, `fix/ssh-host-binding`, and `docs/conventional-naming-rules`. Do not use spaces, underscores, extra path segments, or trailing hyphens.
- `main` and the Changesets-managed `changeset-release/main` branch are exceptions to the work-branch format. Keep the automated release commit and PR title `chore(release): version lazysh packages` compatible with the rule. Naming does not change the requirement to branch from and target `main`.
- Apply these rules to new work; do not rewrite historical commits or rename existing branches solely to conform.

# Issues and pull requests

Use the issue and PR templates in `.github/`, adapted from `akitaonrails/ai-memory`. Keep every required section, state checks accurately, and mark inapplicable checks with a reason. User-facing changes require a `CHANGELOG.md` entry under `[Unreleased]`; call out changed defaults. The templates do not override the trunk-based workflow above.

# Zero duplication

If jscpd detects any duplicates, the pre-commit hook must fail. Refactor duplicated
code with DRY until the repository scan reports zero clones. Do not bypass the
hook, baseline existing clones, relax detection thresholds, or exclude handwritten
source/tests to make it pass. Keep vendor, generated-artifact and legal-notice
scope explicit and preserve third-party attribution. The hook prints this
instruction after every actual run, whether it succeeds or fails.
