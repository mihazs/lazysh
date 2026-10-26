<!-- Adapted from akitaonrails/ai-memory; provenance and MIT notice: .github/TEMPLATES.md. -->

## What changed

<!-- One paragraph or bullet list: the observable behaviour before vs. after. -->

## Why

<!-- The motivation: bug fix, new feature, performance, correctness. Link related issue if any. -->

## Test plan

- [ ] `cargo fmt --all -- --check` passes
- [ ] `git diff --check` passes
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` passes
- [ ] `cargo test --workspace --all-targets` passes
- [ ] Relevant Bun/Turbo frontend, browser, and native platform checks pass
- [ ] Manual test: <!-- describe what you ran and what you observed -->

## Commit attribution

- [ ] I verified the name and email on every commit in this PR and corrected
      any unintended identity before requesting merge. See
      [commit attribution guidance](https://github.com/mihazs/lazysh/blob/main/CONTRIBUTING.md#commit-attribution).

## Release impact

<!-- Check exactly one. This drives which release your change ships in
     (see CONTRIBUTING.md "Versioning and deprecation policy"). -->

- [ ] **Patch**: bug fix, no new surface
- [ ] **Minor**: additive (new feature, flag/subcommand/config key,
      agent integration or provider)
- [ ] **Major (breaking)**: on-disk format, removed/renamed surface, or
      breaking IPC/protocol schema change, called out in "What changed" above

- [ ] This branch started from current `main` and this PR targets `main`,
      including minor and major work. No stacked branches or PRs.
- [ ] I checked that this does not redo something already on `main` or the
      open PRs, or fixed by a closed issue.

## CHANGELOG (merge gate)

- [ ] I added a `CHANGELOG.md` `[Unreleased]` entry. It is **required** for any
      user-facing change: new flag / env var / endpoint / IPC command / settings
      key, changed behaviour, or an observable bug fix. (Exempt only for
      internal refactors, dead-code removal, and test-only churn.)
- [ ] Any changed **default** (flag behaviour, config default, env var,
      response shape) is called out explicitly in "What changed" above.
- [ ] I added the corresponding Changesets fragment (`bun run changeset`),
      or an empty fragment for internal/test-only work. Version PRs consume
      these fragments; they do not publish packages or applications.

Reviewers treat a missing entry as blocking, so add it up front if you want
your PR to merge on the first pass.

## Notes for reviewers

<!-- Anything tricky, a design decision you made, or areas you'd like extra scrutiny on. -->
