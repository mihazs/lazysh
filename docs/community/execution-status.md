# Implementation and verification status

Execution date: 2026-10-31. Work is implemented on review branches, **not merged
or released**. Track [#642](https://github.com/mihazs/lazysh/issues/642), download
PR [#641](https://github.com/mihazs/lazysh/pull/641) and community PR
[#648](https://github.com/mihazs/lazysh/pull/648). The existing source-cut hold in
[#632](https://github.com/mihazs/lazysh/pull/632) is preserved.

## Implemented scope

- README/download PR: truthful positioning and preview assets, preferred Android
  Obtainium setup in README and install guide, flavor filters, checksum examples,
  public-first roadmap and conditional future macOS package instructions.
- Community PR: audit, index, support/security/conduct guidance, beginner/advanced
  contribution paths, first contribution walkthrough and recognition procedure.
- Demonstrations: evidence register and real-native capture instructions; actual
  workflow screenshots/video remain missing. No fabricated capture is included.
- Discovery: local buildless landing artifact with authoritative brand assets,
  semantic HTML and metadata. No public hosting or homepage was configured.
- Launch: technical introductions, unsubmitted community drafts, source-reviewed
  tmux tutorial, FAQ and publication checklist.
- Measurement: weekly aggregate scorecard process and a separate 90-day calendar.
- Starter issues #643–#647: public, bounded, labeled, with explicit dependencies.

## Executed validation

| Check | Actual result and scope |
| --- | --- |
| Markdown links/anchors/images | 45 references in README/install/roadmap PR; community references checked after additions; zero missing local targets |
| Duplication | `bun run duplicates:check` and actual staged pre-commit hook pass, zero clones, on both implementation trees |
| Whitespace | `git diff --check` passes |
| Static HTML | DOM/CSS parsing passes: 15 links, two local brand assets, 29 rules, landmarks/language/alt/unique IDs/viewport; no browser layout claim |
| Contributor test command | `bun run --cwd apps/client test -- src/keyboard.test.ts`: one file, three tests passed |
| Obtainium selection | FOSS and Google regex each matches one v1.3.3 APK asset name and URL |
| Release inspection | Public v1.3.3 API has 14 assets and stable release metadata; downloaded manifest inspected, binaries not independently qualified |
| Review corrections | Fixed stale CONTRIBUTING README anchor and tutorial command newline; reran affected links and staged gate |
| API publication of branches | Git tree IDs compared with locally tested trees before branch updates; direct Git push lacked credentials |

Hosted checks on the PR heads are queued/pending at the last observation, not
reported as passing. Do not equate a source branch with published delivery.

## Remaining gates

- Release hold #632 must resolve before integrating these changes into a new
  source cut. Update against current main, rerun required checks, review and merge
  ready PRs, then verify a separate subsequent version publication and its assets.
- Connector-created commits use the connected account as primary author/committer;
  local commits use Codex. New connector commits include Codex co-author credit,
  but primary attribution must be reconciled before merge under CONTRIBUTING.md.
- Chromium installation failed with invalid ZIP archives after retries. Rendered
  desktop/mobile README, landing layout and browser accessibility remain unexecuted.
- No configured Android SDK, adb, cargo or Xcode executable was available in this
  runtime. Native Obtainium install/upgrade, startup, SSH and real-device capture
  were not performed. Existing native defects remain with their current owners.
- Available connector operations do not include GitHub settings, Discussions
  categories or social-preview upload. Exact administrative steps are in the
  [maintainer checklist](maintainer-setup.md); private reporting is not presumed enabled.
- Hosting is unconfigured. The static artifact needs an authorized hosting choice,
  deployment-specific URLs and actual visual QA before public deployment.

Application Rust/frontend/native suites were not run beyond the focused guide
command: no application runtime code, dependencies or release gates were changed.
No external posts, submissions, purchases or third-party contacts occurred.
See the [90-day calendar](90-day-plan.md) for future maintainer outreach; those
activities have not been executed by this repository work.
