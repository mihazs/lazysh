# Your first lazysh contribution

## Choose a bounded task

Read [CONTRIBUTING.md](../../CONTRIBUTING.md), [AGENTS.md](../../AGENTS.md) and the
[public issues](https://github.com/mihazs/lazysh/issues). Check open PRs and comment
on the issue with your intended scope before substantial work. A private board
is not required. Ask for clarification if acceptance or ownership is unclear.

Documentation, translations, bug reproduction, small accessibility corrections
and isolated tests can be good starting points. SSH trust, credential storage,
transport ownership and native platform integrations need experienced review.
Do not treat every mobile bug as a beginner task.

## Prepare a fork and branch

Fork lazysh on GitHub if you do not have write access. Clone your fork and add
`https://github.com/mihazs/lazysh.git` as `upstream`. Fetch upstream main, then
create a short-lived branch from that exact main commit, for example
`docs/clarify-host-fingerprint`. Use the Conventional Commit types and branch
rules in AGENTS.md. Linked worktrees belong under `~/dev/.worktrees/`.
Never branch from another contributor's unfinished work.

Use Bun **1.3.14** from the root package manifest. Run `bun install --frozen-lockfile`
and `bun run hooks:install`. Native development additionally needs Rust stable,
the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and the
platform tools listed in the [README](../../README.md).
You can edit documentation without compiling the native app. Do not update the
lockfile or install a different package manager as an onboarding workaround.

## Run focused validation

| Change | Minimum relevant checks; add behavior-specific checks |
| --- | --- |
| Documentation | Check changed local links, heading anchors, image references and claims; `git diff --check`; `bun run duplicates:check` |
| Translation text | [Localization guidance](../localization.md), `bun run --cwd apps/client check`, relevant `bun run --cwd apps/client test` cases |
| React/UI | Client `check`, focused Vitest cases, client `build`, relevant Playwright desktop/phone cases |
| Rust or SSH | Affected Cargo package checks/tests and formatting/lint; owned integration tests for changed behavior |
| Native Android/iOS | Applicable native build/runtime acceptance in [Android](../android-testing.md) or [iOS](../ios-testing.md) guides |

For a focused client test use `bun run --cwd apps/client test -- <test-file>`;
first find the real file under `apps/client/src`. For a browser test use
`bun run --cwd apps/client test:e2e -- <spec-file>` after the documented browser
installation. Use actual paths, not placeholder arguments in a PR test record.
Browser success does not establish native input, SSH or physical-device behavior.
Always state failed and unexecuted checks. Never bypass a failing duplicate gate.

## Submit and interpret review

Review `git diff`, add the issue-linked patch, and commit with a Conventional
Commit subject. Inspect author and committer with `git log -1 --format=fuller`.
Push to your fork and open a PR targeting upstream `main`, using all required
template sections. User-facing changes need a root Unreleased changelog entry
and an appropriate Changeset (`bun run changeset`); documentation about workflow
alone has the exemption described in CONTRIBUTING.md.

CI reports checks individually. Read the failed job's first relevant error,
reproduce where possible, fix the cause, then rerun affected checks. A missing
SDK or approval is an unexecuted check, not a pass. Maintainers may need to
approve a first-time fork workflow; never add secrets to make it run.

Respond to review, push corrections on the same branch, and summarize actual
validation. Maintainers merge only after applicable gates pass. A separate
reviewed version PR and verified publication deliver a milestone. A merged PR
is not itself a released installer. Public recognition should link the actual
merged PR and its contributor; ask before using names beyond public attribution.
