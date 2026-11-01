# Connected workspace refinement · current 1.7.1 UI

Tracking: [#738](https://github.com/mihazs/lazysh/issues/738), [#668](https://github.com/mihazs/lazysh/issues/668), [#664](https://github.com/mihazs/lazysh/issues/664), [#663](https://github.com/mihazs/lazysh/issues/663), [#665](https://github.com/mihazs/lazysh/issues/665).
Baseline: `2c8c774f967c6363c9dbda94b11899aff40305a1`, client 1.7.1. Later 1.7.2 metadata does not change the captured frontend. This follows the 1.4 benchmark and 1.5.1 refinement without replaying their fixes.

## Current capture and observed brief

Fresh real-app Chromium fixtures use synthetic saved hosts, two connected app sessions, 30 recorded reports, a separate Herdr discovery snapshot and selected quota data. Mobile 393×852 and desktop 1280×850 use matching state/geometry. Evidence cache: `/home/mihazs/.cache/tmp/lazysh-connected-refinement/`; current workspace owner passes 25 cases with 3 intentional skips. Browser fixtures do not establish SSH, native input, splash or physical-device performance.

1. **Workspaces: needs refinement.** The healthy server selector, shared-focus paragraph and Attach action precede the tree. Ongoing app sessions follow the entire discovered tree. In the current unfiltered one-pane phone capture their first row starts around620px; larger trees make this worse. The screenshot correctly distinguishes two app connections, but reaching one competes with server configuration and host discovery.
2. **Live/recorded activity: retain working structure.** Full-width mobile Agents, direct Live/Activity jumps, neutral reported Attention, progressive report details, current-row focus restoration and disclosed healthy setup are already present. Preserve their mounted readers and exact reading-position guards. Recorded state remains different from a valid request; do not infer running ownership or invent pending badges.
3. **Usage: retain current behavior.** The selected-account page has contextual Back, account identity and truthful stale-data labeling. Its ownership explanation prevents confusing an account quota with the current terminal's account. No new quota controls or information hiding are justified by this capture.
4. **Terminal, Tools and settings: preserve.** Fresh workspace captures confirm compact terminal controls and a bounded default Tools sheet. Existing dedicated mobile settings/categories and explicit saved-host authentication are tested through their current owners. Native splash/IME/background behavior is not established by these captures.

## Implementation hierarchy

- Put existing connected app-session rows first in Workspaces using actual DOM order, followed by discovered host spaces. Keep their names, destinations, selected state and original selection handler. Do not turn discovered panes or recorded reports into app sessions.
- Give healthy Spaces the same explicit server disclosure already used by Agents. Keep the existing shared-focus warning visible exactly once beside discovery, even while setup is collapsed. Missing server, connection failure and unavailable discovery still reveal the necessary setup; Attach and server changes remain explicit.
- Refine navigation modes into compact segmented chrome using existing theme variables. Use one restrained material treatment, opaque readable task content, selected/focus borders and 44px targets. Preserve solid/reduced-transparency/forced-colors/reduced-motion fallbacks and custom themes.
- Keep one AgentPanel, separate Live/Activity refs, content receipts, explicit-jump cancellation, drafts and the same terminal/session instances. No terminal/xterm/input/touch/native/approval logic changes, new backend claims, dependencies or preferences.

## Current reference study

All ten primary references were fetched again during this study. HTML/media hashes live in `references/sources.json`; Moshi agent/chat MP4s were downloaded, decoded and inspected during this run.

| Reference | Relevant adaptation and boundary |
| --- | --- |
| [Moshi agents](https://getmoshi.app/docs/agents-usages), [chat](https://getmoshi.app/docs/chat-view) | Scan work before setup; readable conversation and progressive execution detail. Preserve Lazysh's explicit reported/live distinction rather than copying unsupported rings or approval actions. |
| [Termish](https://termish.dev/), [source](https://github.com/farlume/termish) | Compact host/context actions and spacious task views. Published iOS screens are not Android keyboard reliability evidence. |
| [cmux concepts](https://cmux.com/docs/concepts), [notifications](https://cmux.com/docs/notifications) | Keep workspace/surface scopes distinct and jump to real current work. No fabricated unread or pending state. |
| [Warp vertical tabs](https://docs.warp.dev/terminal/windows/vertical-tabs/) | Prioritize ongoing rows with progressive metadata. No invented Git or agent metadata. |
| [Conductor workflow](https://www.conductor.build/docs/concepts/workflow) | Make the active stream of work the navigation unit; backend delegation/review capability is outside this refinement. |
| [Paradev agent status](https://docs.paradev.com/agent-status) | Conditional truthful state rather than permanent decorative attention badges. |
| [Wave workspaces](https://docs.waveterm.dev/workspaces) | Clear active workspace identity near switching controls. |
| [Termius workspaces](https://docs.termius.com/terminal/workspaces) | Keep focused terminal context with surrounding sessions; do not copy unsupported broadcasting. |
| [OpenCode web](https://opencode.ai/docs/web/) | Dedicated readable conversation context, not a wall of setup. |
| [Blink](https://docs.blink.sh/) | Compact reachable mobile controls; its documentation does not qualify Lazysh native input behavior. |

## Acceptance and evidence limits

Match before/after Workspaces, Agents/Activity and Usage captures at 393×852 and 1280×850. Check two app-session switching, selected identity, healthy/missing/unhealthy server setup, exactly one visible shared-focus warning, explicit server switching/Attach, keyboard focus/DOM order, localization and 44px targets. Exercise 320px, tablet 768px, enlarged text, safe areas and browser keyboard-height constraints. Preserve contextual Back, report focus, exact Activity return position, short-sheet dismissal and existing confirmed input/approval owners.

Run owning App/Herdr frontend tests and relevant workspace/locale/usage/host/settings/approval suites, client build/types, repository formatting and strict zero duplication. Request the shared hook window before commit. Native inventory remains separate: no owned phone/ADB device is known and `/dev/kvm` is absent; do not relabel software-emulator or browser geometry as native acceptance. Parent's prior source-built strict scrolling proof applies only to its admitted unchanged terminal sources and does not qualify this future UI revision or physical-device performance.

## Implementation and qualification

The first connected app-session row moves from approximately 620px to 169px in the matching two-session phone state. Both app connections precede the discovered Spaces section in DOM and keyboard order. Healthy setup is collapsed, while the original shared-focus paragraph remains visible exactly once. Selecting an existing app session keeps its terminal node and changes the discovery host caption to the selected connection. Mode changes retain the same report reader, search draft and terminal node. The bottom manager hint now describes all three supported multiplexers without the misleading tmux-only pane claim under a working Herdr tree.

The new missing-selection fixture initially failed correctly: with one server, an empty selected hint intentionally defaults to that sole server; merely setting the empty choice does not change the selected dependency. The repaired owned phase returns two servers and explicitly refreshes discovery, producing a genuinely ambiguous selection. Empty selector/tree and absent shared-focus warning are asserted strictly, then explicit selection restores the tree. A separate forced reader failure reveals setup and truthful status; recovery closes healthy setup. No production selection hook, oracle, guard or timeout was changed to make this pass. Initial negative artifacts remain in the local cache, as does the independent parent's negative trace.

Parent independently passed the corrected new case on phone and desktop. The owning source tests pass 313 App/Agent cases, and the workspace suite passes 27 with 3 intentional skips before the last text-only refinement; final integrated-head results follow. The new case additionally checks localized manager guidance, 320/600px phone and 768/1280px desktop widths, 420px height and 20px navigation labels, 44px targets and contained text. Existing owning workspace cases check safe-area 62/34 and forced-colors/reduced-motion fallbacks, context/reading-position returns, short sheets and report focus. These are browser checks, not native keyboard acceptance.

Matching evidence: [phone before](connected-workspace-refinement-1-7-1/workspaces-phone-before.png) → [phone after](connected-workspace-refinement-1-7-1/workspaces-phone-after.png); [desktop before](connected-workspace-refinement-1-7-1/workspaces-desktop-before.png) → [desktop after](connected-workspace-refinement-1-7-1/workspaces-desktop-after.png). [Identity/hash manifest](connected-workspace-refinement-1-7-1/captures.json) includes fresh primary-reference/media receipts. Unchanged Usage and large reported-board states remain in the finite local capture cache.

One later capture attempt encountered a terminal-focus/input-routing negative while opening the second synthetic credential dialog; the strict fixture rejected an unexpected 14-unit terminal write and the capture was not accepted. The trace/log remain in `capture-final-premerge`; parent owns separate input/credential triage. Current accepted capture setup waits for the first xterm screen to exist and drains its initial virtual animation frames before opening the next dialog. That is capture admission, not a production mitigation or a claim that the separate focus risk is resolved.
