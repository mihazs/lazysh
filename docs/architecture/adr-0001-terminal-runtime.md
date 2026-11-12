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
