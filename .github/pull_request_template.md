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
- [ ] Relevant moon, Bun frontend, browser, and native platform checks pass
- [ ] Manual test: <!-- describe what you ran and what you observed -->

## Regression test

<!-- Required when the title starts with `fix`: check exactly one box. The `regression-test` check reads this section; other pull
     requests leave both unticked. Rule: "Bug fixes" in AGENTS.md. Index: docs/regression-tests.md. -->

- [ ] **Added**: a test at the lowest layer that reproduces the bug fails on the parent commit and passes here, and `docs/regression-tests.md` has its row. Test: <!-- path and title -->
- [ ] **Not applicable**: an existing test already covers the bug, or no layer can reproduce it. Reason: <!-- the test that already fails on the parent commit, or why none can and the follow-up issue -->

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

- [ ] I added the Changesets fragment (`bun run changeset`) that is this
      change's changelog entry. Its first line is `type(scope): headline`
      (`feat`, `fix`, `perf`, `docs`, `refactor`, `build`, `ci`, `test`, `chore`
      or `revert`; a user-facing headline of at most 110 characters), then a blank
      line and the details. It is **required** for any user-facing change: new flag
      / env var / endpoint / IPC command / settings key, changed behaviour, or an
      observable bug fix. Internal refactors, dead-code removal and test-only
      churn use an empty fragment, or one for a completed milestone. A root
      `CHANGELOG.md` `[Unreleased]` entry is no longer required. Check the result
      with `bun run changelog:preview`.
- [ ] Any changed **default** (flag behaviour, config default, env var,
      response shape) is called out explicitly in the fragment's details and in
      "What changed" above.
- [ ] A completed milestone has a real version bump and published release,
      including a patch fragment for an internal/test-only milestone. Version PRs
      consume these fragments; their merges trigger verified application
      publication. Creating a fragment alone does not publish anything.

Reviewers treat a missing entry as blocking, so add it up front if you want
your PR to merge on the first pass.

## Notes for reviewers

<!-- Anything tricky, a design decision you made, or areas you'd like extra scrutiny on. -->
