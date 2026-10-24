# Moshi reconstruction evidence

Research date: 2026-10-24. Target: the publicly shipped Moshi SSH/agent client at [getmoshi.app](https://getmoshi.app/), including mobile and desktop surfaces. This is a behavior catalog for an independent lazysh implementation. It contains no recovered proprietary implementation or copied application assets.

**Evidence levels:** `documented` means the vendor describes the behavior; `artifact-observed` means bytes or metadata were inspected; `inferred` means an implementation implication; `unknown` means no adequate observation. Documented capability is not proof that an installed build behaves that way. This catalog does not certify lazysh parity.

## Shipped artifact inspection

The [desktop download page](https://getmoshi.app/desktop) linked Moshi Go Alpha **0.5.28** and an older desktop **0.4.23** during this investigation. Selected official download: [Linux amd64 Debian package](https://cdn.getmoshi.app/desktop-go/moshi-go_0.5.28_amd64.deb).

| Item | Observed identity |
| --- | --- |
| Downloaded package | `moshi-go_0.5.28_amd64.deb` |
| Package SHA-256 | `5b21940597985c07767dee60f34de287d3de8f374303035e09c1a017c7b3d42d` |
| Extracted executable | `opt/moshi-go/moshi-go` |
| Executable SHA-256 | `c3043607369f45f8e57fc0aed7ab20e9570b9b6175a4e1291dceebc47a3601b0` |
| Executable size | 37,929,223 bytes |
| REA operation | `inspect_go_binary` |
| REA Evidence ID | `ev_fb7235a5115581739876b36af1ae284abd6ef51247b011a2b3830d63ee5c8e0d` |
| Provider | REA Go build-information reader v1, rea-agents 6.7.0 |

**Artifact-observed:** ELF amd64/little-endian, embedded `go1.27.1` version, module `moshi-go`, revision `e5f6f7f755e50d54c7d8d623b21e596052b8b6f5`, build timestamp `2026-10-24T03:58:53Z`. Recorded metadata includes `github.com/egoist/mygo` replaced by `github.com/rjyo/mygo`, `github.com/rjyo/moshi/app-hook` replaced by a local development path, Chroma, Goldmark, WebSocket, PTY, and text-layout dependencies. Package inventory additionally contains `libghostty-vt.so`, `libmygo-sqlite3.so`, launcher metadata, and icons.

**Limitations:** embedded metadata can be forged; it does not prove dependency authenticity, the compiler actually used, invocation of a dependency, rendering performance, or runtime behavior. No native functions were decompiled, no target executable was launched, and no target account or private data was accessed. REA's Go inspector is target-free; no native analysis session was opened. Research downloads remain outside the repository in `/tmp/lazysh-research`.

The latest artifact is a Go application, so assuming that current Desktop is Electron or a JavaScript bundle would be wrong. The [desktop install guide](https://getmoshi.app/docs/install-desktop) separately describes the browser UI embedded in `moshi-hook`; those are distinct delivery surfaces. Their exact equivalence to the new Go alpha remains unknown.

## Behavior checklist

Every entry below is **documented**, unless otherwise marked. Rows define acceptance targets, not completed lazysh features. Platform qualifications are part of the behavior and must not be silently dropped.

| Area | Moshi behavior to account for | Evidence |
| --- | --- | --- |
| Connections | Named saved hosts, username/port, passwords or private keys; Auto tries Mosh, ET, SSH; forced transport selection; Mosh UDP range/server path; experimental TCP-based ET. | [Connections](https://getmoshi.app/docs/connections) |
| SSH identity/routing | Generate/import/paste private keys, reject public-key input, show fingerprints and export public key. SSH-only bastion routing and optional single-identity agent forwarding; forwarding disabled by default. VPNs use ordinary OS routing. | [Connections](https://getmoshi.app/docs/connections) |
| Session lifetime | Several active connections, switching/closing/reopening, last-session resume. Persistent remote processes belong to the multiplexer. Reconnect reattaches tmux/Herdr; Zellij supports initial selected attach but lacks equivalent automatic restoration. Optional client environment flag. | [Sessions](https://getmoshi.app/docs/terminal-sessions) |
| Terminal/history | Bounded local scrollback; new output must not pull a reader out of history. Mosh cannot reconstruct remote scrollback. Durable history, search and copy remain available through tmux copy mode. | [Scrolling](https://getmoshi.app/docs/scrolling) |
| Multiplexer discovery | Independently discover tmux, Herdr and Zellij and list active sessions. Offer recent project directories derived from agent history, then start an appropriate remote workspace. | [Multiplexers](https://getmoshi.app/docs/multiplexer) |
| tmux | Attach/create sessions, configurable prefix, window/pane actions, numbered window controls, detach, and project-directory launcher. | [tmux](https://getmoshi.app/docs/tmux) |
| Herdr | Persistent named servers, workspaces/tabs/panes, configurable prefix, numbered tabs, pane zoom, per-agent state and exact event context. | [Herdr](https://getmoshi.app/docs/herdr) |
| Zellij | Detect/list/attach, initial auto-attach, shortcut panel, numbered tabs and remote action bridge. No documented Jump To tree, session deep links, custom prefix, or reconnect restoration. | [Zellij](https://getmoshi.app/docs/zellij) |
| Jump navigation | Live tmux session/window and Herdr workspace/tab trees; current item and Herdr agent state; list/accordion/grid layouts with remembered preference. Plain shell and Zellij report unavailable rather than fabricating a tree. | [Jump To](https://getmoshi.app/docs/jump-to) |
| Touch gestures | Configurable terminal taps, swipes, two-finger swipes, pinch font/pane zoom, header pull depths, toolbar alternate actions, D-pad corners and reset. Defaults distinguish tabs, panes, and workspace/session levels. | [Gestures](https://getmoshi.app/docs/gestures) |
| Keyboard/shortcuts | Reorderable terminal toolbar; Ctrl/Meta, arrows/D-pad, Enter/Backspace and snippets. Simple modifier sequences plus validated advanced chords, function keys and per-step modifiers. Hardware app/session shortcuts, Option-as-Meta, optional toolbar auto-hide. | [Keyboard](https://getmoshi.app/docs/keyboard) |
| Clipboard/links | Paste, long-press selection, URL open/copy, OSC 52 remote-to-device clipboard, and multiplexer escape passthrough. Preserve raw text rather than trying to repair already wrapped output. | [Clipboard](https://getmoshi.app/docs/clipboard) |
| CJK/IME | Compose text before sending to the remote program; mixed Latin/CJK cell alignment and configurable glyph fallback. IME input must work in agent TUIs and chat. | [CJK input](https://getmoshi.app/docs/cjk-input), [Personalization](https://getmoshi.app/docs/personalization) |
| Dictation | Parakeet and Whisper downloaded local models, Apple SpeechAnalyzer on supported iOS, optional metered cloud engine, language selection, editable draft mode, optional auto-send, transcription history and model removal. | [Voice](https://getmoshi.app/docs/voice) |
| Appearance | Whole-app and terminal themes, custom theme import via JSON/clipboard/QR/deep link, on-demand/imported fonts, CJK fallback, cursor shape/blink, app icons, UI locale and session list/card preference. iOS glass is platform-specific. | [Personalization](https://getmoshi.app/docs/personalization) |
| Secure storage | Separate connection metadata from passwords/keys/passphrases/fingerprints, delete credentials with a host, biometric key access and resume checks, separate settings and credential sync toggles, biometric confirmation for private-key export. | [Security/sync](https://getmoshi.app/docs/security-sync) |
| Agent hooks | Optional host companion normalizes lifecycle events and reads local agent transcripts; managed configuration entries preserve existing hooks. TUI use remains possible without the companion. | [Hooks](https://getmoshi.app/docs/hooks) |
| Agent board | Per-session Needs you/Working/Done state grouped by project and host; latest events collapse; valid approval rows take priority; archive and age-out behavior; optional keep-awake display. | [Agents/usages](https://getmoshi.app/docs/agents-usages) |
| Usage/context | Provider/account-specific rate-limit windows, freshness timestamps, manual refresh and optional background collection; transcript-supported context remaining. Missing data must remain unknown. | [Agents/usages](https://getmoshi.app/docs/agents-usages) |
| Native chat | A view over the existing TUI's transcript: messages, Markdown/code, images, thinking, tool cards/results, plans/questions, working/stop state and editable composer. Prompts return to the same live tmux/Herdr session; unsupported interactions direct the user to the terminal. | [Chat View](https://getmoshi.app/docs/chat-view) |
| Remote approvals | Exact multiplexer pane targeting; re-capture and validate that the pending prompt still matches before injecting an answer. Answering at the host clears the remote pending action. This works across tmux, Herdr and Zellij. | [Multiplexers](https://getmoshi.app/docs/multiplexer) |
| Attachments | Camera/photo/file/clipboard sources, arbitrary file types, SSH copy to the host, paste a host-local path or attach it to an editable prompt, optional host clipboard handoff; images can be cropped/annotated. | [Image/file paste](https://getmoshi.app/docs/image-paste), [Homepage](https://getmoshi.app/) |
| Shareable uploads | Separate optional HTTPS upload service produces expiring URLs, upload history, thumbnails and expiry-aware copy/delete; this is distinct from private host-local transfer. | [Files](https://getmoshi.app/docs/files) |
| Diff review | Staged/unstaged/untracked changes, per-file side-by-side highlighted hunks, binary-file listing, remembered file, current working tree and repository browsing at historical commits. Same host/SSH gateway; CLI entry point also available. | [Diff viewer](https://getmoshi.app/docs/diff-viewer) |
| Browser previews | Discover HTTP listeners, show process/port/interface, optional port/range allowlist, confirm selection, then forward through SSH to device loopback. Try matching local port and fall back to an unused port; session close tears down forwards. | [Browser preview](https://getmoshi.app/docs/browser-preview) |
| Simulator previews | Mata on a macOS host streams iOS simulators and Android emulators/devices with video and touch/button control; boot/reboot/shutdown and agent accessibility actions. Requires host SDKs; not just an SSH shell feature. | [Simulator preview](https://getmoshi.app/docs/simulator-preview) |
| Notifications | Push registration/testing/pause, custom webhook alerts, normalized agent-event inbox updates, notification actions, cross-device delivery and tmux/Herdr active-session deep links. iOS ActivityKit delivery uses a separate lifecycle from ordinary notifications. | [Notifications](https://getmoshi.app/docs/notifications) |
| Apple surfaces | iOS Live Activities/Dynamic Island plus native watchOS inbox/approval and usage screens, complications and background freshness. Watch is a glance/action surface, without terminal, scrollback or attachments. | [Apple Watch](https://getmoshi.app/docs/apple-watch), [Live Activity](https://getmoshi.app/docs/live-activity) |
| Host settings | Discovery, usage collection, nested-agent suppression, unlocked-Mac notification suppression, HTTP port scanning and Mata can be controlled independently; restart semantics vary by setting. | [Hook settings](https://getmoshi.app/docs/hook-settings) |
| Desktop | Local and remote hosts, session/chat switching, workspace/agent sidebar, command palette, files with code/Markdown/media viewing, forwarded previews, and line/element comments included in the next agent prompt. Terminal ownership remains on the host. | [Desktop](https://getmoshi.app/desktop) |

## Agent coverage

The [official support tiers](https://getmoshi.app/docs/hooks) distinguish capabilities rather than treating every CLI as equally integrated:

| Tier | Documented agents | Acceptance meaning |
| --- | --- | --- |
| Native Chat View | Claude Code, Codex, OpenCode, Antigravity, Kimi, Cursor, Grok Build, Pi, OMP, Hermes, Qoder, Factory Droid, GitHub Copilot, Amp, Devin, OmO, jcode | Transcript adapter plus agent-aware events and terminal compatibility. Safe actions vary by agent/prompt. |
| Agent-aware only | Gemini, Qwen Code | Lifecycle/inbox/notification integration; use the TUI for conversation. |
| Terminal compatibility | Other interactive host CLIs | A working terminal is sufficient; detection, transcript parsing, native resume, usage and remote approvals are separate promises. |

The exact native event schemas, transcript formats, model catalogs and per-agent action mappings have **not** been established by this investigation. An integration logo or CLI name is insufficient evidence that its complete workflow works.

## Trust boundaries and unresolved evidence

1. **Documented direct data path:** terminals, transcripts, diffs, file browsing and previews travel between client and owned host through SSH. Inbox summaries, push and usage snapshots use the vendor backend; shareable uploads and optional cloud dictation also leave the device/host. A lazysh implementation needs explicit, separately enabled external services rather than claiming that every feature is offline. [Chat transport](https://getmoshi.app/docs/chat-view), [files](https://getmoshi.app/docs/files), [voice](https://getmoshi.app/docs/voice).
2. **Unverified key claim:** vendor security copy mentions the Secure Enclave, while import/export of arbitrary SSH private keys is also documented. This investigation cannot establish hardware non-exportability. lazysh should describe its actual platform-keystore protection, authentication policy and export behavior precisely. [Security/sync](https://getmoshi.app/docs/security-sync).
3. **Documentation drift:** the Jump To page disclaims pane/tab deep links, but the newer notifications reference describes them. The personalization page says nine themes while listing ten. Preserve feature intent and verify the installed version before depending on exact counts or URL grammar. [Jump To](https://getmoshi.app/docs/jump-to), [notifications](https://getmoshi.app/docs/notifications), [personalization](https://getmoshi.app/docs/personalization).
4. **Runtime unknown:** no hands-on Moshi mobile/desktop session, SSH server handshake, roaming test, approval race, dictation engine or battery/frame-time benchmark was executed. Android/iOS parity and which documented features have reached each build remain unverified. The catalog is not a pixel-perfect or performance specification.
5. **Implementation choice:** lazysh can retain the useful agent principle—one durable host session with multiple views—without copying Moshi's source, visual assets, service endpoints, licensing system or proprietary notification infrastructure. Account billing is not a prerequisite for the requested SSH/agent experience.

## Verification gates for parity

- Real SSH tests: password and encrypted key auth, first-use trust and changed-key refusal, PTY resize, UTF-8/IME, large sustained output, disconnect cleanup and cancellation.
- Real multiplexer tests: discover/attach/reconnect without killing agents; preserve exact host/session/pane identifiers, including hostile names and changed state.
- Agent tests: recorded-format adapters plus a live session for each claimed integration; no invented usage/context; stale, duplicate and already-answered approvals fail closed.
- Native tests: Android and iOS device lifecycle, network changes, biometric cancellation and secure-storage deletion; desktop builds on each advertised OS.
- Data tests: bounded buffers/transcript paging, authenticated loopback gateways/forwards, no credentials in settings/logs/backups, and no unsolicited uploads.
- Accessibility/performance tests: keyboard-only control, screen readers, touch targets, CJK cell width, long-output responsiveness, idle CPU/battery and measured release size.

Catalog status: public capability discovery **answered**; shipped desktop identity **answered**; internal protocols and native runtime parity **unresolved**; cross-platform performance **unresolved**. Track the unresolved implementation and verification work as GitHub issues before calling lazysh feature-complete.
