# Terminal performance: product requirements

Status: **proposed**. Tracking: [epic #1302](https://github.com/mihazs/lazysh/issues/1302). This document states what must be true, what is known about the current terminal, and what is deliberately undecided. Its only measurements are the desktop xterm.js baseline recorded in [benchmarks](terminal-benchmarks.md#measured-baseline) (headless Chromium, not an Android WebView); no device or native-candidate result exists. Every figure marked *provisional* is a target, not a measurement.

Companion documents: [runtime](terminal-runtime.md) · [adapter](terminal-adapter.md) · [native rendering](native-rendering.md) · [platform integration](platform-integration.md) · [benchmarks](terminal-benchmarks.md) · [migration plan](terminal-migration-plan.md) · [ADR 0001](adr-0001-terminal-runtime.md).

## Problem

The terminal is xterm.js inside the Tauri WebView. Android battery use and responsiveness are the priority; iOS, Linux, Windows and macOS must not regress. The code shows several structural properties that make the terminal a plausible cost centre, but none has been measured (see [Known facts](#known-facts-about-the-current-terminal) and [Hypotheses](#hypotheses-to-test-not-findings)).

## Goals

- Minimal input-to-render latency and low CPU under sustained output; near-zero idle CPU and GPU; predictable memory across sessions; consistent rendering under heavy output.
- Behaviour parity with today's terminal, and a terminal that survives renderer failure or recreation.
- Separation of UI, emulation, rendering and transport; independently replaceable terminal implementations behind a `TerminalAdapter`.
- Decisions backed by reproducible measurements. If a native path does not beat the xterm.js fallback on a device, the faster verified implementation stays for that device and platform.

## Non-negotiable requirements

| Area | Requirement |
| --- | --- |
| Transports | SSH, Mosh, Eternal Terminal and local PTY keep working. |
| Multiplexers and agents | tmux, Zellij and Herdr integrations; Claude Code, Codex and OpenCode TUIs. |
| Terminal features | Colors, cursor modes, Unicode/graphemes/emoji/CJK/combining/wide characters, bracketed paste, mouse reporting, escape sequences, alternate screen, clipboard (OSC 52 consent), scrollback, selection. |
| Input | Android soft and hardware keyboards and IME composition without duplicated or corrupt commits. |
| Accessibility | Screen-reader access to terminal content. |
| Security | SSH trust, authentication, permissions and session isolation unchanged. |
| Reliability | No session loss when a renderer fails or is recreated; no unbounded buffers; no busy-loop rendering; no silent byte loss or reordering. |
| Platforms | No platform is degraded without a documented, tested fallback. |

## Known facts about the current terminal

Each statement was read from the checked-out code.

- Engine: `@xterm/xterm` pinned exactly to **5.5.0** with `@xterm/addon-fit` and `@xterm/addon-web-links` (`apps/client/package.json`). No WebGL or canvas renderer addon is a dependency, so xterm's default DOM renderer is in use.
- Defaults that matter for cost: `cursorBlink: true`, `scrollback: 5000` lines (range 100 to 20000), `lineHeight: 1.3` (`preferences.ts`, `terminal.ts`).
- Output path (traced for SSH in `ssh.rs` and local PTY in `local.rs`; the Mosh and ET output paths were not traced individually): the Rust session worker sends at most 16 KiB chunks through a Tauri `Channel`. `SshEvent::Data { data: Vec<u8> }` reaches TypeScript as `number[]` (`bridge.ts`) and is copied with `new Uint8Array(event.data)` (`App.tsx`). Flow control is a 256 KiB credit window (`OUTPUT_WINDOW` in `ssh.rs`, `WINDOW` in `local.rs`); credits return through one `ack_output` call per written chunk, issued from xterm's write callback.
- State ownership: each session's screen and scrollback exist only in a JavaScript xterm `Terminal`. Android Activity/WebView replacement closes renderer-owned sessions (`cancel_for_renderer_rebind` in `ssh.rs`; [session lifetime](../explanation/session-lifetime.md)).
- Version-pinned monkey patches of xterm private fields exist for IME composition (`terminalIme.ts`), Mosh canonical resize (`moshResize.ts`), custom bold color (`terminalBold.ts`), viewport clamping and fit (`terminal.ts`, `terminalFit.ts`). Mosh resize and bold color throw on an unrecognised xterm build; the IME layer, viewport helpers and fit measurement silently do nothing on one.
- A VT engine other than xterm.js already ships in the repository for a different purpose: `packages/herdr-upstream` vendors libghostty-vt and a Rust binding ([runtime](terminal-runtime.md#vt-engine-libghostty-vt-assessment)).
- Measurements: none. `docs/reference-evidence.md` lists cross-platform performance as unresolved and issue #20 states the gates without data.

## Hypotheses to test, not findings

1. The DOM renderer costs more CPU and battery than a GPU or native renderer under sustained output.
2. The JSON number-array channel and per-chunk acknowledgement IPC add CPU and latency that do not scale with the visible screen.
3. Holding every session's scrollback in the WebView heap makes memory grow with session count and makes renderer recreation destructive.
4. Cursor blink and DOM updates prevent idle power savings.

Each hypothesis maps to a benchmark in [terminal-benchmarks](terminal-benchmarks.md). A hypothesis that fails is recorded as such.

## Provisional targets (not measurements)

- At least 20% lower Android energy on matched workloads.
- At least 25% improvement in one key latency or CPU metric without a material regression elsewhere.
- Near-zero idle renderer activity; stable memory across session churn; no input-latency regression under heavy output; no correctness regression.

## Scope and phasing

Android is the optimization priority; contracts and tests cover all five platforms from the start. The order is: baseline and contract first (no behaviour change), then the shared Rust core, then renderer candidates, then platform surfaces. See [migration plan](terminal-migration-plan.md) for the issue-level slice order.

## Out of scope

Replacing SSH/Mosh/ET transports, changing multiplexer integrations, and any change to the credential or app-lock model other than the explicit review required where renderer replacement semantics could change ([runtime](terminal-runtime.md#lifecycle)).

## Unresolved questions

- Does native composition work inside the Tauri WebView on each platform? ([native rendering](native-rendering.md#composition-gate))
- Is a GPU renderer faster or more efficient than an optimized xterm.js renderer on the target Android devices?
- How should scrollback configured in lines map to libghostty-vt's byte limit?
