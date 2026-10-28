# Verified GitHub release gate

`.github/workflows/release-tag.yml` publishes verified Android, Linux and Windows
installers after a Changesets version merge. Publication is enabled by default;
setting `enabled` to false stops new release admission and publication API calls.
Ordinary unchanged-version main pushes skip release builds successfully.
Apple releases remain deferred. Official F-Droid inclusion and free-software
remote push acceptance (#344) remain pending: the corresponding policy fields
record that separate status and do not gate GitHub publication. No official
F-Droid submission is performed by this workflow. Candidate-specific source
builds, scans, signing and artifact verification still gate every release.
A prior version's APK cannot authorize a new candidate.
The initial #353 local recipe checkpoint is qualified in `fdroid/README.md`.

The gate accepts only an exact main event SHA checked
out by the workflow, with a stable version/code increase from its first parent.
Existing release-consistency checks cover all owned manifests, locks and native
Android authority. Every pending Changeset fragment blocks admission; a version
PR must consume them before release. Non-main candidates, prereleases and
regressions fail closed. Dispatch has no arbitrary
source or tag input. The repository must retain candidate history.

The committed manual-update recipe remains unchanged. Its SHA256 must match the
reviewed policy digest. Only source commit, build version/code and current
version/code selectors change in a disposable copy. The source selector equals
the exact event SHA, avoiding a self-referential committed SHA. All provisioning,
source libraries, removal rules, output and build commands remain identical.
F-Droid's update modes remain None: creating a Git tag alone does not establish
automatic F-Droid updates or official inclusion.

The owned official buildserver container provisions the recipe's existing host
dependencies and declared SDK, uses pinned fdroidserver, requires an explicit
clean source-scan receipt, then runs its native build and binary scans without
force or skip options. Actual unsigned APK identity, version, non-debuggable
state and Google-free graph/manifest/dex assertions must pass. Receipts persist
and the owned container is removed even on failure. This is the ordinary local
container build path, not a claim of Vagrant `--server` execution or hermeticity.

Only the dependent tag and publication jobs have contents-write tokens. Every
platform installation build and the independent F-Droid source build must pass
before tagging. The tag command rechecks synchronized current-main metadata and
requires the candidate within its bounded first-parent ancestry with the same
release version; a newer version supersedes it. Existing lightweight
tags at the same commit are idempotent; different/annotated targets fail. A
concurrent create can succeed only if its new ref resolves to that same commit.
The workflow never updates/deletes/forces a tag and never ignores a failed
build. Repository administrators can still change tags outside this workflow;
repository tag protection remains separate. The main-head check and reference
creation are separate API requests, so main can advance between them; the tag
always names the verified candidate rather than an inferred moving branch.
The normal GITHUB_TOKEN does not trigger downstream workflows through tags;
installation publication is an explicit dependent job in the same workflow.
It rechecks every package/checksum, creates a draft, verifies each uploaded asset's
acknowledged digest, and publishes only after all uploads succeed. Existing
releases are never overwritten or automatically resumed after uncertain outcomes.
See [release-artifacts.md](release-artifacts.md) for signing and activation limits.

`bun run test:release` runs the native Bun release tests. The tag tests use
in-memory HTTP responses and do not create real refs, containers or builds.
Official API reference: [Git references](https://docs.github.com/en/rest/git/refs),
[least-privilege workflow tokens](https://docs.github.com/en/actions/reference/security/secure-use),
and [F-Droid metadata](https://f-droid.org/docs/Build_Metadata_Reference/).
