# Development workflow

Use trunk-based development.

- Fetch the latest `main` before starting work. Create every work branch and worktree from `main` or `origin/main`.
- Never branch from another feature, fix, or documentation branch. Do not create stacked pull requests.
- Target `main` for every pull request and merge completed work into `main`.
- If a change depends on another change, merge that prerequisite into `main` first, then start the dependent branch from updated `main`.
- Keep branches short-lived. Track work with GitHub issues, the project board, and pull requests.
- Never open draft pull requests. Open a PR only when its change is complete and locally verified, then drive it to merge. Keep at most 10 pull requests open at a time; finish, merge or close existing ones before opening more.
- Review changes, address findings, and run relevant checks. Once ready, merge autonomously; do not leave a ready pull request open awaiting user confirmation.
- Every completed milestone must lead to a published version. Follow the release policy in `CONTRIBUTING.md`; version preparation or a merge alone is not delivery. Verify the public release and its assets before reporting the milestone released.
- Release every completed issue; do not batch finished work into a later release. After a PR with a user-facing changeset merges, merge the regenerated Changesets version PR (`chore(release): version lazysh packages`) as soon as its `release-tools` check passes, then verify the published GitHub release and its assets before reporting the issue released. Do not hold other ready PRs to keep releases separate; the next version PR ships whatever merged meanwhile.
- Create every Git worktree under `~/dev/.worktrees/`.

# Continuous delivery without waiting

Never idle on CI. A merged pull request is a finished checkpoint.

- Open a pull request only when its slice is complete, tested and shippable on its own (tests, docs, CHANGELOG and changeset included). It is merged as soon as its required checks are green, so it must never carry half-wired code or work in progress.
- After pushing a pull request, keep implementing the next slice while CI runs. Start the next branch from fresh `origin/main`, or locally on top of the pushed branch when it depends on it, but do not open stacked pull requests: open the dependent pull request after its prerequisite has merged. The 10-open-PR limit still applies; at the limit, keep developing locally and open the pull request when a slot frees.
- Do not poll CI, sleep on checks or merge your own pull requests when the PR driver is running (`/tmp/lazysh-driver/driver.py`, status in `/tmp/lazysh-pr-status.json`). It squash-merges a pull request when its required checks are green, reruns failed jobs up to twice, approves and merges the Changesets version pull request under its safety conditions, and records `needs-owner` or `needs-rebase`. Read the status at natural breaks and fix those states immediately. A pull request that must not merge yet is listed in `/tmp/lazysh-pr-hold.txt`.
- Without the driver, merge your own pull request when the required checks pass, as described above, and still continue with the next slice instead of waiting.

# Continuing implementation

Treat “continue”, “resume”, and “keep implementing” as requests to execute the
unfinished objective in the conversation. Across sessions, use
`lazysh-history-research` and the installed ai-memory handoff skill to recover it,
then verify progress against the checkout, open PRs, linked issues, and the live
roadmap in `docs/roadmap.md`. Memory supplies evidence of prior work; the current
user request supplies authorization.

Context recovery, a plan, a status report, or completion of one issue does not
finish a request to keep implementing the broader roadmap. After recovery, take
the next actionable acceptance criterion through implementation and relevant
checks; review and merge ready work using the workflow above, then continue with
the next remaining item in the requested scope. Join an existing PR for that work
instead of starting a duplicate. Keep progress updates in commentary.

End the turn when the requested scope is complete, the user asks to stop or pause,
or further progress requires specific missing input, access, or an external event.
If one item is blocked, continue independent work in scope when available; report
the exact blocker and remaining work when no such work remains. Do not require
the user to invoke Codex `/goal` or repeat “continue”. Create a goal only when
explicitly requested. A recap-only or planning-only request remains read-only.

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
