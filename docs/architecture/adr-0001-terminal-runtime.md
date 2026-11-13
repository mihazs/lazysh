# ADR 0001: terminal adapter and shared Rust runtime

- Status: **Proposed**. It becomes Accepted only when the validation listed at the end exists. Date: 2026-11-11.
- Decision makers: repository maintainer. Tracking: [epic #1302](https://github.com/mihazs/lazysh/issues/1302).
- Related: [PRD](terminal-performance-prd.md) · [runtime](terminal-runtime.md) · [adapter](terminal-adapter.md) · [native rendering](native-rendering.md) · [migration plan](terminal-migration-plan.md).

## Context

The terminal is xterm.js 5.5.0 (DOM renderer) in the Tauri WebView. Its state lives in JavaScript, its output arrives as a JSON number array with one acknowledgement IPC per chunk, and four modules patch xterm private fields. Android battery and responsiveness are the priority, but no terminal measurement exists.

Evidence read from the repository (not measured behaviour):

| Evidence | Source |
| --- | --- |
| xterm pinned to 5.5.0, no WebGL or canvas addon dependency | `apps/client/package.json` |
| Output is `number[]`, copied to `Uint8Array`, acknowledged from the write callback | `bridge.ts`, `App.tsx` |
| Credit window 256 KiB; SSH chunks 16 KiB | `ssh.rs`, `local.rs` |
| Terminal state exists only in the WebView; WebView replacement closes sessions | `terminal.ts`, `ssh.rs` `cancel_for_renderer_rebind`, [session lifetime](../explanation/session-lifetime.md) |
| xterm-private seams: IME, Mosh resize, bold color, viewport, fit | `terminalIme.ts`, `moshResize.ts`, `terminalBold.ts`, `terminal.ts`, `terminalFit.ts` |
| libghostty-vt and a Rust binding are already vendored with patches and provenance; Android is not a mapped build target; only Linux x86_64 builds in CI | `packages/herdr-upstream` |
| No terminal performance data; #20 states gates only | `docs/reference-evidence.md` |

## Decision

1. Introduce a `TerminalAdapter` contract and make the existing xterm.js behaviour its first implementation (`XtermTerminalAdapter`). This is justified independently of performance: it isolates version-pinned internals and makes terminal behaviour testable by one contract suite.
2. Build one shared Rust terminal core on the **existing** libghostty-vt binding. No second Ghostty dependency or VT engine is added without a documented justification that the existing engine fails a stated requirement.
3. The core owns one authoritative display state per session. The native adapter sends small commands and events, never cells.
4. **The renderer is not decided here.** wgpu is the first candidate; the choice per platform follows the benchmarks. If a native renderer does not beat xterm.js on a device, that device keeps xterm.js.
5. Native composition is gated by proof-of-concept results per platform; a failed gate means that platform keeps xterm.js or uses a documented alternative.
6. xterm.js stays as the working fallback with observable, recorded selection. Native is never the default before its platform gates pass.
7. Source integrity checks and tests for the vendored Ghostty source (#384) are not weakened to make the integration easier.

## Consequences

Positive (expected, to be confirmed by measurement): terminal state can outlive a renderer; the bridge no longer carries per-byte JSON for the native path; xterm-specific code is confined; behaviour parity is testable.

Negative or risky: a second terminal implementation to keep behaviourally aligned (mitigated by shared conformance fixtures); build complexity for Zig and the Android NDK; ghostty-vt's resize reflows by default, which conflicts with Mosh's canonical resize; scrollback is configured in bytes there and in lines in lazysh; and renderer-replacement semantics are security-relevant and need review.

## Alternatives considered

| Alternative | Why not chosen now |
| --- | --- |
| Keep xterm.js and only optimize it | Kept as a measured candidate; it does not by itself move state out of the WebView |
| Native renderer first, adapter later | Risks building for a surface that cannot be composed; breaks the "no behaviour change first" rule |
| A second VT engine (for example Alacritty or WezTerm terminal crates) | Second dependency without evidence of need; the vendored engine already covers parsing, dirty rows and input encoding |
| WASM terminal inside the WebView | Retains the byte bridge; kept as a measured candidate |
| Thread per session | No profiling justification |

## Validation required before Accepted

- A recorded xterm.js baseline and an optimized xterm.js variant ([benchmarks](terminal-benchmarks.md)).
- Composition PoC results on a physical Android device (and iOS) ([native rendering](native-rendering.md#composition-gate)).
- libghostty-vt cross-built for Android and iOS with integrity checks intact.
- A passing contract suite for both adapters and conformance fixtures with reviewed divergences.
- A security review of renderer-replacement session behaviour.

## Validation gaps at the time of writing

No physical Android device, no emulator, no Zig toolchain and no iOS, Windows or macOS host were available to the author. No claim about performance, energy, rendering, build success on other targets or device behaviour is made in this ADR.

## Amendment 1 (2026-11-12): first renderer shootout results

Scope: [#1323](https://github.com/mihazs/lazysh/issues/1323), the part that can run on the available host. Evidence: [renderer shootout](terminal-benchmarks.md#renderer-shootout-xtermjs-renderers-1323), raw files `benchmarks/terminal-shootout-*.json`. The decision rule of [native rendering](native-rendering.md#renderer-candidates) and the [acceptance of a candidate](terminal-benchmarks.md#acceptance-of-a-candidate) apply unchanged. The status of this ADR stays **Proposed**.

**What was measured.** xterm.js 5.5.0 with its DOM renderer, its canvas addon and its WebGL addon (software and hardware GL), the same workloads and fixtures, one desktop host, headless Chromium, one geometry, three invocations for DOM and WebGL on hardware GL. **What was not:** every device (no Android, iOS, Windows or macOS), energy, thermal and battery, the Linux and Apple WebViews, and every native candidate: wgpu, Skia or Android Canvas drawing and a WASM terminal were not built. Candidates that were not built are neither eliminated nor selected.

Criteria, for the WebGL addon on hardware GL against the DOM renderer (this host only):

| Criterion | Result |
| --- | --- |
| No correctness regression | Met: every workload ended on the expected screen in all runs. |
| No input-latency regression under heavy output | Met: echo p50 14.3 to 14.6 ms against 14.7 to 15.3; p95 and p99 higher by 2 to 3 % (30.7 and 32.5 ms against 30.0 and 31.7), within one 16.7 ms frame. |
| Near-zero idle activity | Met, better with a blinking cursor (no style recalculation against 640 to 675 per 10 s); equal with blink off. |
| Stable memory across session churn | Met per session (6.5 to 6.8 MiB against 7.3 to 7.7); fixed cost higher (JS heap about 14 MiB, renderer resident set about 8 to 12 %). |
| At least 25 % better in one key latency or CPU metric | Met on ANSI-heavy output (W3 total process CPU 0.8 to 1.0 s against 2.1 to 2.9 s) and on the ten-session echo p99 (16.2 against 25.4 ms). |
| Without a material regression elsewhere | **Not cleared**: W3 frame interval p99 33 to 116 to 197 ms with 13 to 21 dropped frames against 2 to 5; W4 total process CPU about 10 % higher at the median (0.34 against 0.31 s). |
| At least 20 % lower Android energy | **Not measurable here**: no Android device, no battery counters. |

Decisions, recorded per candidate and platform:

| Candidate or platform | Decision |
| --- | --- |
| xterm.js DOM renderer | Stays the default and the fallback everywhere. No default changes. |
| xterm.js canvas addon | Does not proceed. It was 16 to 46 times slower than the DOM renderer on W2 and W4 and slower under sustained output, with and without GPU flags. |
| xterm.js WebGL addon on a software rasterizer | Not a usable configuration (0.22 to 0.26 MiB/s). Any use of the WebGL addon must be gated on real hardware acceleration and must fall back to the DOM renderer, which is capability probing ([#1336](https://github.com/mihazs/lazysh/issues/1336)) before anything else. |
| xterm.js WebGL addon on hardware GL | **Proceeds to the next gate as the leading measured candidate** and is the cheapest to adopt (no native composition risk). It does not ship: it needs device measurements on Android (energy, thermal, context loss and recovery, memory pressure, background and resume), a fix or mitigation for the W3 frame-pacing regression, a replacement for the custom bold color seam (`configureTerminalBold` was refused on the WebGL and canvas renderers in smoke runs of the harness), and a screen-reader decision. |
| wgpu, native Skia or Android Canvas drawing | Not built, so no decision. They remain candidates for devices where the WebGL addon fails the criteria, which only device runs can show. The Renderer API and a CPU reference renderer ([#1322](https://github.com/mihazs/lazysh/issues/1322)) are the plug point and the correctness oracle. |
| WASM terminal | Not built, so no decision. One existing implementation, ghostty-web 0.4.0 (MIT, libghostty-vt compiled to WebAssembly; its npm metadata and package contents were inspected, it was not installed in the repository or run), bundles its own prebuilt `ghostty-vt.wasm`; adding it would put a second Ghostty build, whose provenance was not verified, beside the vendored and hash-checked source ([#384](https://github.com/mihazs/lazysh/issues/384)). Building a WASM from the vendored source is the alternative; either needs a maintainer decision. |
| Android, iOS, macOS, Windows, Linux | Undecided for every platform: no device measurement exists. Tauri's Linux WebView is WebKitGTK and the Apple ones WKWebView, so Chromium results do not apply to them; Android System WebView and WebView2 are Chromium, but their GPU paths were not measured. |

Next measurements, in order: the Android manual procedure with the WebGL addon and the DOM renderer on a physical device ([#1340](https://github.com/mihazs/lazysh/issues/1340)); W3 frame pacing with the WebGL addon on the phone viewport; a WebGL context-loss run. A native candidate is built only if those show the WebGL addon missing the criteria on a device.
