## What changed

Apply the pending Changesets release plan to the private lazysh release train.
Package changelogs contain the generated release entries. Bun, Cargo and Tauri
share the resulting product version; no binaries or packages are published,
and no tags or store releases are created by this PR or its merge.

## Why

Record reviewed changes and their release impact together. Refs #215.

## Test plan

- [ ] Release consistency and real-tool integration checks pass on this exact head.
- [ ] Relevant existing CI checks pass; approve the default-token workflow runs.
- [ ] `cargo fmt --all -- --check` passes
- [ ] `git diff --check` passes
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` passes, or reviewer records why not applicable to version-only changes.
- [ ] `cargo test --workspace --all-targets` passes, or reviewer records why not applicable to version-only changes.
- [ ] Relevant Bun/Turbo frontend, browser, and native platform checks pass, or reviewer records their scope.
- [ ] Manual test: review generated versions/changelogs and any migration notes; no publishing or device test is implied.

## Commit attribution

- [ ] Verify automated commits are attributed to GitHub Actions and any human commits retain the intended author.

## Release impact

Select the highest impact in the consumed changesets before merging:

- [ ] **Patch**: bug fix, no new surface
- [ ] **Minor**: additive surface
- [ ] **Major (breaking)**: breaking change, with migration notes reviewed
- [ ] This release branch is rebuilt from current `main`, targets `main`, and is not stacked.
- [ ] Existing main/open work was checked; this is the pending generated release plan.

## CHANGELOG (merge gate)

- [ ] Root `CHANGELOG.md` history and `[Unreleased]` entries remain intact.
- [ ] Generated package changelogs match consumed fragments; changed defaults and breaking behavior remain explicit.

## Notes for reviewers

This is version-only automation. The default `GITHUB_TOKEN` can create
approval-required PR workflow runs; a writer must approve them. Do not merge
without the applicable exact-head checks and normal review. This workflow does
not configure an App/PAT, registry credentials, publishing, tags or store releases.
