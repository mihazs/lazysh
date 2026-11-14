# Verified GitHub release gate

`.github/workflows/release-tag.yml` publishes verified Android, Linux and Windows
installers for explicitly allowlisted publication and each future individually
merged Changesets version. Historical versions are not backfilled. Publication is enabled by default;
setting `enabled` to false stops new release admission and publication API calls.
Main pushes start this workflow only when they change
`apps/client/android-version.properties`. Release consistency requires that file to
equal the version-derived name/code, so every version transition rewrites it and an
unchanged version cannot. Ordinary pushes therefore queue no release job. The filter
only avoids queueing work; admission still decides. A missed push can be repeated
with an ordinary main dispatch (`initial: false`), which runs the same admission.
Apple releases remain deferred. Official F-Droid inclusion and free-software
remote push acceptance (#344) remain pending: the corresponding policy fields
record that separate status and do not gate GitHub publication. No official
F-Droid submission is performed by this workflow. Candidate-specific source
builds, scans, signing and artifact verification still gate every release.
A prior version's APK cannot authorize a new candidate.
The initial #353 local recipe checkpoint is qualified in `fdroid/README.md`.

Ordinary admission accepts only an exact main event SHA checked out by the
workflow, with a stable version/code increase from its first parent and no pending
Changesets. A version PR must consume those fragments before ordinary release.
Existing consistency checks cover all owned manifests, locks and native Android
authority. Non-main candidates, prereleases and regressions fail closed.

Allowlisted publication alone uses a main `workflow_dispatch` with `initial: true` and
`expected-source-sha` equal to the exact event/checkout SHA. Committed policy
allowlists unpublished 1.3.0 and its failed candidate as bounded first-parent ancestor
`f5186cf2dbd534ec24e4d1eed63033a8b9728126`; the reviewed repair source must follow it.
This mode admits an unchanged version and retains pending Changesets for the next
release. Prepare, tag and publish repeat the same checks. Dispatch cannot select
arbitrary source or tags. Ordinary unchanged-version pushes skip builds; neither
mode discards pending fragments to force admission.

The supported future workflow merges one Changesets version per main push; it does
not enumerate arbitrary batched transitions or history. Per-source concurrency
preserves different version runs. The repository must retain candidate history.

The earlier 1.0.0 candidate failed its source scan because newly installed desktop
WebDriver tools carried prebuilt zip.js WebAssembly. The corrected recipe removes
that unused acceptance-only package before scanning; unexpected binaries still
fail. That repair used the then-current 1.0.0 allowlist; published versions remain
immutable. The current 1.3.0 failure and its unresolved Windows acceptance evidence
are recorded in [the installation guide](install-and-update.md#current-native-acceptance-status).
Ordinary unchanged-version pushes intentionally skip admission, and rerunning the
failed event would rebuild its old source. After reviewing and merging the repair,
dispatch the allowlisted path with the exact reviewed main SHA. It rebuilds every
source and installation gate for that new source before creating any tag. It does
not reuse old build receipts, rewrite the failed candidate, alter a published tag,
or bypass a scan. Pending follow-up fragments remain for the next version instead
of being discarded or consumed by this source-qualified publication.

The committed manual-update recipe is pinned to its reviewed inputs. Its SHA256 must match the
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

## Job graph and runner queue

A release takes two runner-queue entries on its critical path and eleven runner slots
(previously five entries and fourteen slots). Each GitHub-hosted job waits in the
account-wide queue, so stages that run one after another add queue time.

1. `source-build` starts with admission and recipe preparation, which were a
   separate `candidate` job. Each later step requires `enabled == 'true'` from that
   admission. The platform builds in `release-artifacts.yml` start in the same queue
   entry. They bind the exact trusted main event SHA, hold contents-read tokens and
   produce private same-run artifacts only.
2. `reserve` runs beside them, takes no part in the critical path and starts the
   candidate's branch reservation (see
   [Ref writes and workflow files](#ref-writes-and-workflow-files)).
3. `publish` needs all three, and requires admission `enabled`, a successful source build,
   successful platform builds and a successful reservation. It aggregates and
   reverifies every downloaded receipt, package digest, `release.json` and `SHA256SUMS`, then creates the tag and
   publishes. This replaces the separate aggregate, tag and publish jobs.

Only `reserve` and `publish` have a contents-write token, and only the reservation,
tag and publication steps receive it; `reserve` runs nothing else, and the tag and
publication steps run after aggregation and verification. Every platform
installation build and the independent F-Droid source build must pass before
tagging. Tagging and publication require the exact verified candidate
within observed main’s bounded first-parent ancestry (at most 4097 commits).
A newer main version does not supersede it, and newer source is not executed or
substituted. Side ancestry or replaced main history is rejected. Existing lightweight
tags at the same commit are idempotent; different/annotated targets fail. A
concurrent create can succeed only if its new ref resolves to that same commit.
The workflow never updates/deletes/forces a tag and never ignores a failed
build. The only ref it ever deletes is its own reservation branch, and only after
publication succeeded and only while that branch still names the candidate commit.
Repository administrators can still change tags outside this workflow;
repository tag protection remains separate. The main-head check and reference
creation are separate API requests, so main can advance between them; the tag
always names the verified candidate rather than an inferred moving branch.
The normal GITHUB_TOKEN does not trigger downstream workflows through tags;
installation publication follows tagging in the same job.
It rechecks every package/checksum, creates a draft, verifies each uploaded asset's
acknowledged digest, and publishes only after all uploads succeed. The final PATCH
uses `make_latest: legacy` to select latest by creation date and semantic version
rather than build completion order. Existing
releases are never overwritten or automatically resumed after uncertain outcomes.
Every release includes the current native acceptance status from
[install-and-update.md](install-and-update.md#current-native-acceptance-status);
initial notes additionally include the root Unreleased changes. Missing status
blocks note generation. Passing build gates does not claim full native parity.
See [release-artifacts.md](release-artifacts.md) for signing and activation limits.

## Ref writes and workflow files

Version 1.30.0 and 1.30.2 were built and verified but never published: `publish`
failed with `tag creation failed (HTTP 403)` and, once a tag existed, `cannot create
draft release`, while 1.30.1 and 1.30.3 published through the same workflow, token
and permissions. GitHub's answer was a bare `Resource not accessible by integration`
with `x-accepted-github-permissions: contents=write; contents=write,workflows=write`.

Cause, reproduced with throwaway refs: a `GITHUB_TOKEN` cannot hold the `workflows`
permission, and GitHub refuses it any ref or release write for a commit whose
`.github/workflows` tree is not identical to the tip of some existing **branch**
(tags do not count). `git push` states the reason: `refusing to allow a GitHub App to
create or update workflow ... without workflows permission`. The release commit
is main's tip when the run starts, so the check passes then. The builds take 40 to
90 minutes, and `.github/workflows` changes land on main often. Once one has, no branch
carries the candidate's workflow files any more, except by chance (another open branch
cut from the same main, which is the likely reason 1.30.1 and 1.30.3 passed), so the
tag, and later the release, is refused. Creating a
branch at an old commit whose workflows matched no other branch flipped every
previously refused commit with those files to 201, and removing it restored the 403.

`reserve` therefore creates `release-candidate/<candidate sha>` at the candidate while
it is still main's tip. It is create-only and idempotent, like the tag: a branch that
names another commit fails. `publish` removes it after the release is public. A failed
run keeps its branch, so rerunning only the failed jobs can still publish; delete a
`release-candidate/*` branch yourself once its candidate is abandoned. The reservation
adds no trust: it names the verified commit, and every tag, digest and ancestry
check above still decides. If `reserve` itself is refused, a workflow change landed
on main before the job started: `publish` is skipped (the builds still run) and the
next version carries that candidate's changes.

Failures now carry GitHub's message (at most 200 printable characters, token-like
strings redacted) and request id, never headers or other body fields, so the next
unexplained refusal can be reported to GitHub support with its request id.

`bun run test:release` runs the native Bun release tests. The tag tests use
in-memory HTTP responses and do not create real refs, containers or builds.
`tests/release-workflow.test.ts` expands the release workflows for a release push
and checks the job graph: queue entries, runner slots, publication dependencies,
write scope, exact checkout source, uploaded targets and restore-only caches.
Official API reference: [Git references](https://docs.github.com/en/rest/git/refs),
[least-privilege workflow tokens](https://docs.github.com/en/actions/reference/security/secure-use),
and [F-Droid metadata](https://f-droid.org/docs/Build_Metadata_Reference/).
