# Connected workspace refinement · baseline 1.5.1

Tracking: [#668](https://github.com/mihazs/lazysh/issues/668), [#664](https://github.com/mihazs/lazysh/issues/664). Baseline: `91d6f8ba7f800170939a1946dae18322c5569ac9`.

## Observed baseline

Repository Playwright synthetic fixtures passed 25 workspace checks (3 intentional platform/viewport skips). Evidence is retained under `/home/mihazs/.cache/tmp/lazysh-workspace-redesign/before/`; browser evidence does not establish native Android or SSH acceptance.

The connected terminal already has compact chrome and nearly edge-to-edge output. Preserve that improvement. On a 393px phone the Agents drawer instead leaves a strip of obscured terminal beside a long working view. Its brand, navigation, section jumps, repeated Herdr headings and separate refresh row postpone the first live agent to below half the viewport. Generic footer copy occupies scarce working space. Activity uses separate oversized detail controls and filters wrap prematurely. Healthy setup is already disclosed and must stay so. Existing dedicated mobile settings and bounded Tools sheets should be refined, not rewritten from historical screenshots.

## Proposed implementation

Make Agents and Workspaces dedicated full-width mobile destinations with the existing return action. Reduce connected navigation header/footer spacing without removing About or connection identity. Consolidate Herdr identity, section heading and accessible icon actions into one compact header; preserve status groups, host context, search and server disclosure. Use compact activity rows and progressive report details, retaining explicit recorded/live distinctions. Use opaque readable list surfaces with restrained glass only on navigation chrome and bounded sheets. Resolve every color through existing theme variables and retain accessibility fallbacks.

Preserve one mounted AgentPanel, separate Live/Activity DOM references, reading-position receipts, drafts, session identity, confirmed actions and terminal internals. No new backend capabilities, preferences, input routing or dependencies.

## Reference evidence

- [Moshi agents](https://getmoshi.app/docs/agents-usages) and [chat](https://getmoshi.app/docs/chat-view): downloaded public MP4s establish grouped compact sessions and conversation continuity; do not copy unsupported ring metrics.
- [Termish](https://termish.dev/) and [source](https://github.com/farlume/termish): compact hosts and contextual actions. Published iOS images are visual evidence only.
- [cmux concepts](https://cmux.com/docs/concepts) and [notifications](https://cmux.com/docs/notifications): clear scope and direct attention jumps, using only real state.
- [Warp vertical tabs](https://docs.warp.dev/terminal/windows/vertical-tabs/): progressive row metadata.
- [Conductor workflow](https://www.conductor.build/docs/concepts/workflow): task context without persistent setup clutter.
- [Paradev agent status](https://docs.paradev.com/agent-status): conditional status badges.
- [Wave workspaces](https://docs.waveterm.dev/workspaces): workspace identity near navigation.
- [Termius workspaces](https://docs.termius.com/terminal/workspaces): focused terminal with surrounding session context.
- [OpenCode web](https://opencode.ai/docs/web/): readable conversations with expandable execution detail.
- [Blink](https://docs.blink.sh/): compact keyboard-aware controls; native input behavior remains outside this stream.

Current HTML/media receipts and SHA256 hashes are retained in the evidence cache `references/sources.json` and `references/media-retry.json`.

## Acceptance

Match before/after mobile 393×852 and desktop states; examine narrow/tablet/enlarged text, keyboard-open synthetic geometry, safe areas, contrast, focus and localization. Exercise saved host → terminal, switching, Live/Activity details/return with exact reading position, contextual usage/settings Back, short-sheet dismissal, truthful unhealthy/empty states and confirmed approvals/input. Run existing owning unit/Playwright suites, types/build/lint/format and zero duplication. Probe native availability without using unidentified targets; report unexecuted Android acceptance explicitly.

## Implementation and captured evidence

[Phone before](workspace-redesign-1-5-1/agents-phone-before.png) → [phone after](workspace-redesign-1-5-1/agents-phone-after.png), both 393×852. [Desktop before](workspace-redesign-1-5-1/agents-desktop-before.png) → [desktop after](workspace-redesign-1-5-1/agents-desktop-after.png), both 1280×850. Hashes and fixture/source qualifications are in [captures.json](workspace-redesign-1-5-1/captures.json). These establish navigation/list hierarchy; synthetic terminal text is not evidence of SSH or native rendering performance.

The first live-agent row moves from approximately 523px to 369px on the phone, and recorded activity fits below it without expanding healthy configuration. Report rows remain explicit recorded context; selecting a row focuses its existing detail reader and clearing restores the originating row's focus. Live focus actions and valid pending approvals retain their existing distinct handlers.

| Surface | Current evidence and decision |
| --- | --- |
| Hosts | Existing `hosts.spec.ts` brand, responsive gutters, explicit connection/multiplexer and restoration checks; preserve its compact rows and explicit edit controls. |
| Preferences | Captured `preferences-category-entry.png`: a full-width mobile page with collapsed categories and persistent close action, not an oversized mobile modal. Preserve categories and mounted drafts. |
| Usage | Existing contextual-usage workspace capture and return tests preserve the source session and exact Activity reading position. Preserve the dedicated page and Back action. |
| Conversation | Existing `chat-follow.spec.ts` exercises real conversation scroll ownership, explicit Jump to latest and rejected late responses; preserve opaque reading surfaces and composer/input implementation. |
| Files | Existing `file-review-locales.spec.ts` owns literal file content, horizontal keyboard scrolling, upload consent and editable comments. Preserve its dedicated reader and input checks. |
| Pending requests | Existing localized Agent Board acceptance keeps a held decision bound to its original valid request across language changes. ApprovalPanel remains ahead of recorded Activity; top Activity jump makes that region reachable. A reported “Attention” group remains read-only context, with no new authority or approval action. |
| Short sheets | Existing Workspace tools capture/checks preserve six default session actions and bounded disclosures, dismissal and 44px targets. |

All ten reference sources were inspected; public Moshi agent/inbox/chat MP4s were downloaded and decoded. Termish screenshots inform hierarchy, not Android input reliability. No native terminal/input/controller files changed.

## Verification ledger

- **Verified:** client TypeScript/build; App and AgentPanel 308 tests; reviewed AgentPanel 90 tests including current-row focus restoration across status changes and hidden/locked focus guards; workspace 25 browser checks with 3 intentional skips; localized agent discovery and valid held-approval ownership; Hosts/Preferences, contextual usage and conversation checks. Repository formatting: 16 tasks passed. Duplication: zero clones. `git diff --check`: clean.
- **Measured:** actual brand-theme primary text `rgb(248,252,255)` and secondary text `rgb(173,196,218)` over opaque list surface `rgb(16,34,54)` give 15.61:1 and 8.96:1 contrast. Both text opacities are 1 and the reading sidebar has no backdrop filter. Custom themes remain user-controlled; this measurement does not certify arbitrary imported palettes.
- **Qualified failures retained:** running localized suites on isolated port 1436 triggers their existing fixed-1420 external-request guard; using their expected 1420 passes. At a custom 393px file-review viewport, three tests expecting the synthetic short line to overflow fail because it fits; unchanged owning 390×844 viewport passes all six file-review cases. Neither guard nor assertion was relaxed.
- **Not executed:** native Android Back, SSH/background lifetime, IME/input, touch scrolling and device rendering performance. The existing SDK ADB probe reports no connected devices. Parent independently verified that an SDK emulator and one system image are installed, but `/dev/kvm` is absent; uncalibrated software emulation was not launched as native IME/performance evidence. Browser fixture geometry establishes frontend layout only. Root independently executed workspace all-target Rust Clippy on c721f7a9 and it passed (2m56s). The later visible-focus repair changes TypeScript only and preserves the exact Rust/native production trees; Clippy was not rerun for that later head. Native platform acceptance remains unqualified.

Existing default themes, preferences, input routing, connection behavior, authentication and approval authority are unchanged. The companion metadata change merged after this 91d baseline touches no changed production UI paths and is integrated by the parent stream.

Independent review found a stale DOM focus target when a selected report moves between status groups during polling. The current selected rendered row now owns the existing ref; the owning regression proves Working → Done column replacement restores focus to the current row. Automatic detail focus checks current visibility/source/access and document visibility. No approval logic changed.

The 393px file-review negative was resolved by strengthening the shared synthetic fixture's second comment line, retaining the exact XSS literal, line count, line-one annotation and all original content/overflow assertions. The original short input measured 369px client/369px scroll width; a long line measured 369px/6757px and ArrowRight moved scrollLeft to 34. The repaired owning fixture passes all six file cases at 393×852 and 390×844; affected repository renderer owners pass 16/16. One initial canonical-width upload-fixture timeout is retained; a subsequent stable six-case run passes. No product failure cause is inferred from that timeout.

Additional executed layout evidence: 320px and 600px widths at 420px height with 20px live content, [393px safe areas 62/34](workspace-redesign-1-5-1/agents-safe-area-393.png), forced-colors/reduced-motion fallbacks, and [768px tablet context](workspace-redesign-1-5-1/agents-tablet-768.png) retaining a sidebar and more than 400px for the terminal. These are browser checks, including simulated keyboard-height constraints, not native IME acceptance.

Final terminology review: recorded companion state now reads “Attention” / “Atenção” / “Atención”, distinct from the unchanged inbox wording for requests. Consumers are AgentPanel state groups/filters and read-only Herdr reported-session detail; no native locator contains the old literal, and no pending-request or approval handler changes. The owning Agent tests assert all three neutral labels, unchanged inbox wording and absent approval controls.

Final terminology checks: AgentPanel and unchanged NotificationPanel owners pass 93 tests together; localized browser board ownership/discovery passes all 12 cases. Matching after captures were refreshed with the neutral label; build/types and zero duplication pass again.

A second independent browser review found that Clear selection restored focus to an offscreen row: with 30 reports at 393×852 its top was 3933px and bottom 4047px. The owning browser regression first failed with viewport ratio 0 while the row was focused. Clear now uses normal focus to reveal the current selected row; terminal and navigation scroll-restoration code remain unchanged. The real-browser owner passes 14 cases, including both viewport checks for the last of 30 rows at 95% visibility; AgentPanel passes 90 tests and contextual usage/Activity return owners pass 9 with 1 intentional skip. Build/types and zero duplication pass. Initial negative trace/repro remain in the evidence cache; no timeout or viewport oracle was weakened.
