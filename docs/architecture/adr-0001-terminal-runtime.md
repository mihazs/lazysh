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

Amended on 2026-11-18 ([Amendment 6](#amendment-6-2026-11-18-waydroid-is-the-android-acceptance-environment)): for the Android release the physical-device evidence above is replaced by the Waydroid acceptance lane, with what Waydroid cannot show recorded as accepted risk, not measured. Amendment 7 ([below](#amendment-7-2026-11-18-the-native-engine-is-the-default-wherever-its-surface-passes)) adds no device requirement: the other platforms are accepted on the CI hosts the project has, and what those hosts cannot show is recorded the same way.

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

## Amendment 2 (2026-11-13): native candidates measured on the host and on Waydroid

Scope: [#1323](https://github.com/mihazs/lazysh/issues/1323), the native candidates that could be built and run without a physical device. Evidence: [renderer pipeline cost](terminal-benchmarks.md#renderer-pipeline-cost-host-microbenchmark-not-a-candidate), [WebAssembly VT versus xterm.js, parse only](terminal-benchmarks.md#webassembly-vt-versus-xtermjs-parse-only-host-microbenchmark-not-a-candidate), [Android Canvas drawing of the shared layout](terminal-benchmarks.md#android-canvas-drawing-of-the-shared-layout-waydroid-not-a-device) and [wgpu prototype against the CPU reference renderer](terminal-benchmarks.md#wgpu-prototype-against-the-cpu-reference-renderer-host-gpu-not-a-device). The decision rule and the [acceptance of a candidate](terminal-benchmarks.md#acceptance-of-a-candidate) apply unchanged. The status of this ADR stays **Proposed**; this amendment supersedes the rows of Amendment 1 for wgpu, native drawing and the WASM terminal.

**What was measured.** A wgpu 30 prototype of the Renderer API (offscreen, dot-pattern glyphs, no text) against the CPU reference renderer on one discrete desktop GPU, identical in pixels on every case it was checked on; the Android `Canvas` (Skia) replaying the same layout on Waydroid, whose GPU is the same desktop part; libghostty-vt built to WebAssembly from the vendored, hash-checked source against xterm.js's parser on one V8. **What was not:** any phone, any Android GPU driver, wgpu on Android, a text pipeline on the GPU (glyph rasterization, shaping, font fallback, atlas eviction), desktop Skia, a WASM terminal's renderer and bridge, energy, thermal behaviour, a window surface. These results rank nothing on any device.

Decisions, recorded per candidate:

| Candidate | Decision |
| --- | --- |
| wgpu | **Stays a candidate; not measured where it matters.** The prototype is correct against the oracle and a frame is cheap on a desktop GPU (draw plus present 0.25 to 0.51 ms at the median against 0.45 to 1.72 ms for the CPU reference renderer), but that excludes all text cost, the first GPU context added about 61 MiB resident on this driver (an xterm.js session costs 7 to 8 MiB), and no phone GPU was measured. It does not displace the xterm.js WebGL addon as the next thing to measure on a device. It becomes the native candidate to continue only if device runs show the WebGL addon missing the criteria, and its next gates are a text path with real fonts ([#1325](https://github.com/mihazs/lazysh/issues/1325), [#1337](https://github.com/mihazs/lazysh/issues/1337)) and a Vulkan surface on Android ([#1327](https://github.com/mihazs/lazysh/issues/1327)). |
| Native drawing (Android `Canvas`, which is Skia) | **Stays the Android-specific candidate; not selected.** On Waydroid the number of Canvas calls, not the GPU, decided the frame: batching text runs made a full-screen repaint 1.6 to 4.2 times faster than one call per draw, and no hardware frame exceeded 10 ms. Per-row display lists were not built, wide, combining and emoji clusters cannot be batched, there is no wire format for sending a frame from Rust to Kotlin ([#1337](https://github.com/mihazs/lazysh/issues/1337)), and nothing ran on a device. |
| WASM terminal | **Does not proceed on current evidence.** libghostty-vt as WebAssembly parsed 1.3 to 5.8 times faster than xterm.js's parser on the same V8, but parsing is not what costs most in the baseline (ANSI colour through `xterm.write` with the DOM renderer ran at 4.3 MiB/s while the parser alone ran at 61 MiB/s), a WASM terminal still needs a renderer in the WebView (the xterm.js shootout again) and a JavaScript bridge that carries every byte and every dirty row. Reconsider only if a device shows parse-bound CPU. The supply-chain question of Amendment 1 does not arise: the module was built from the vendored source, not taken from a package. |
| xterm.js DOM renderer, WebGL addon, canvas addon, software GL, every platform | **Unchanged from Amendment 1.** The DOM renderer stays the default and the fallback everywhere; no platform, rollout stage or default changes. |

Next measurements, in order: the xterm.js WebGL addon and the DOM renderer on a physical Android device ([#1340](https://github.com/mihazs/lazysh/issues/1340)); only if the WebGL addon fails a criterion there, a wgpu text path and a Vulkan surface on the same device.

## Amendment 3 (2026-11-13): the WebGL addon at the phone viewport and under context loss

Scope: [#1323](https://github.com/mihazs/lazysh/issues/1323), the two measurements Amendment 1 named as next that do not need a device. Evidence: [WebGL at the phone viewport](terminal-benchmarks.md#webgl-at-the-phone-viewport-and-its-first-ansi-heavy-burst-1323), [the first-burst stall](terminal-benchmarks.md#the-first-burst-stall-follows-the-number-of-new-visible-cells-1323) and [WebGL context loss and recovery](terminal-benchmarks.md#webgl-context-loss-and-recovery-1323), [the same runs in the Android System WebView on Waydroid](terminal-benchmarks.md#the-same-runs-in-the-android-system-webview-on-waydroid-1323), raw files `benchmarks/terminal-shootout-*-phone.json`, `benchmarks/terminal-first-burst-*.json` and `benchmarks/terminal-context-loss-*.json`. The status of this ADR stays **Proposed**.

**What was measured.** The harness of Amendment 1 at the `phone` viewport (390 by 844 CSS px at 3x, 46 by 37 cells) for the DOM renderer and the WebGL addon on hardware GL, two invocations each, and a scripted WebGL context loss and restore of the addon (hardware GL twice, software GL once). **What was not:** a phone or any mobile GPU (the Android System WebView of the Waydroid guest, on the host's desktop GPU, ran the context-loss and a subset of the first-burst rows), energy, a real GPU-process crash or app backgrounding, many terminals losing contexts at once, and why the first-burst stall costs what it does.

What changed in the evidence on the WebGL addon:

| Amendment 1 item | Now |
| --- | --- |
| "W3 frame-pacing regression" (p99 116 to 197 ms on the desktop grid) | **Reframed, not fixed.** At the phone grid the steady state paces like the DOM renderer (frame interval p99 16.7 to 16.8 ms and no dropped frames in runs 2 to 5 of both invocations). The first W3 run of each page was a stall: 0.26 to 0.30 MiB/s, 6.7 to 7.7 s of wall time, 12.7 to 15.1 s of CPU, 285 to 343 dropped frames, against 66 to 82 ms for the same bytes afterwards. The harness's median of five runs hid it. The desktop runs have the same state-dependence (per-run W3 throughput 2.5 to 28 MiB/s). The first ANSI-heavy output a user sees with the addon is therefore the case to fix or avoid, and a mitigation must be shown by a run, not assumed. A follow-up run isolated what it follows: the cold pass costs 0.19 to 0.22 ms of CPU per distinct visible cell at the phone grid (1.3 to 1.5 s for 6,100 to 6,600 cells, 5.8 to 6.1 s for about 33,800, against 0.1 to 0.15 s for the same bytes afterwards), for every style family, in a paced run that renders the same 66 frames each pass, and not for the DOM renderer. W3 is that cost at a higher cell count (its accumulating attributes give 17,000 to 71,000 distinct cells at 0.5 to 4 MiB: cold 3.0 to 23.2 s of CPU) and 1.2 to 1.6 times the per-cell rate, for a reason that was not isolated. The stall reproduces in the Android System WebView of the Waydroid guest at 1.2 to 1.5 times the per-cell cost of desktop Chromium with the phone viewport (cold excess 0.6 s for 6,500 cells, 3.0 s for 33,000, 3.7 s for W3 1 MiB; frame interval p99 99 to 156 ms), while the warm WebGL pass is about twice as fast as the DOM renderer there (270 against 471 to 636 ms for 66 frames). A mitigation must reduce the number of first appearances or their cost; none was tried. |
| CPU on streaming output | **Not a general win.** On the phone grid the addon's total process CPU was 1.5 to 2.1 times the DOM renderer's on W3 and W4 (0.14 to 0.23 s more per workload); on the desktop grid it was lower on W3. Idle with a blinking cursor (27 to 29 against 134 to 165 ms of main-thread time per 10 s, no style recalculations) and echo latency with five or ten streaming sessions (p50 8.4 to 8.7 and 7.4 against 12.0 to 12.3 and 11.1 ms) are better with the addon on both viewports. The "at least 25 % better in one key metric" criterion is met at the phone grid by those two; the "no material regression elsewhere" criterion is still **not cleared** because of the first-burst stall. |
| Context loss and recovery (was unmeasured) | **Met on the host for what a script can do.** Restored inside the 3 s grace period, the addon repairs itself and the terminal is pixel-identical to one that never lost its context, including output written while lost. Never restored, `onContextLoss` fires after 3.0 s; disposing the addon leaves a DOM terminal with identical pixels and an intact buffer, and a new addon draws identical pixels again. The app has none of this code (it does not load the addon), so adopting the addon includes writing that handler and a test like `e2e/terminal-webgl-context-loss.spec.ts`. In the Android System WebView of the Waydroid guest the scripted loss gave the same outcomes in two invocations. The WebView's real loss modes (GPU process kill, memory pressure, backgrounding) and a phone GPU are unmeasured. |
| Bold-color seam | Unchanged: refused by the addon in all four phone invocations. |

Decisions, recorded per candidate and platform:

| Candidate or platform | Decision |
| --- | --- |
| xterm.js WebGL addon on hardware GL | **Stays the leading measured candidate; still does not ship and is not cleared.** Open gates, in order: the first-burst stall (cost per new visible cell measured, W3 explained by its cell count apart from a 1.2 to 1.6 times per-cell excess; mitigate and re-measure at both grids), a context-loss handler in the app with its test, a replacement for the custom bold color seam, a screen-reader decision, and the device runs of [#1340](https://github.com/mihazs/lazysh/issues/1340) (energy, thermal, a real WebView's context-loss modes, memory pressure, background and resume). |
| xterm.js DOM renderer | Unchanged: the default and the fallback everywhere. |
| xterm.js canvas addon, WebGL on a software rasterizer, wgpu, Android Canvas, WASM terminal | Unchanged from Amendments 1 and 2. |
| Every platform, rollout stage and default | Unchanged. No fallback is removed. |

Next measurements, in order: where the addon's 0.2 ms per new cell goes (a profile of a cold pass: glyph drawing, atlas page merging, texture uploads) and whether a mitigation (drawing common glyphs ahead of the first output, a larger atlas, limiting style variety) removes the first-burst cost; then the device runs of [#1340](https://github.com/mihazs/lazysh/issues/1340).
## Amendment 5 (2026-11-14): wgpu on its OpenGL and OpenGL ES backends against Vulkan

Scope: [#1323](https://github.com/mihazs/lazysh/issues/1323), the one wgpu question that a host without a phone can still answer: what the OpenGL ES path costs next to Vulkan. Evidence: [wgpu on its OpenGL and OpenGL ES backends against Vulkan](terminal-benchmarks.md#wgpu-on-its-opengl-and-opengl-es-backends-against-vulkan-same-host-gpu-not-a-device), six runs of the unmodified bench on one AMD GPU with Mesa 26.2.6 (Vulkan through RADV, OpenGL 4.6 and OpenGL ES 3.2 through radeonsi), the pixel-for-pixel comparison with the CPU reference renderer under each. The status of this ADR stays **Proposed**; this amendment supersedes only the wgpu row of Amendment 2.

**What was measured.** The same wgpu prototype, frames and workloads on three backends of one GPU. Correct under all three (the four comparison tests pass). At the phone-sized 80x24 grid a frame cost the same within the host noise (median p50 ratio to Vulkan 1.07 for GL 4.6 and 1.00 for GLES 3.2, full repaints 0.97 to 1.08); at 152x38 it cost 1.36 and 1.19 times more at the median; the p99 was higher than Vulkan's in 31 of the 32 stream-row comparisons (median 1.7 and 1.4 times) and exceeded 10 ms once in 120 cells (18.1 ms, in a run taken under load); the first context added about 65 MiB resident against 61 MiB. **What was not:** any Android GLES driver (the GLES context was Mesa's, forced from the environment), wgpu on Android at all, an EGL window surface, energy, text.

| Candidate | Decision |
| --- | --- |
| wgpu | **Stays a candidate; its OpenGL ES fallback works on one desktop driver and is unmeasured on Android.** Where Vulkan is missing, the prototype renders the same pixels through wgpu's OpenGL ES path at about the same median frame cost at the phone grid and a worse tail. That removes one reason to rule wgpu out and adds none to choose it: no phone GPU, no Android build, no text path and no energy figure exist, so the decision of Amendment 2 stands (it becomes the native candidate to continue only if device runs show the xterm.js WebGL addon missing the criteria, and its next gates are text, [#1325](https://github.com/mihazs/lazysh/issues/1325) and [#1337](https://github.com/mihazs/lazysh/issues/1337), and a Vulkan surface on Android, [#1327](https://github.com/mihazs/lazysh/issues/1327)). |
| Native drawing, WASM terminal, xterm.js renderers, every platform | **Unchanged** from Amendments 1 and 2. The DOM renderer stays the default and the fallback everywhere; no platform, rollout stage or default changes. |

## Amendment 6 (2026-11-18): Waydroid is the Android acceptance environment

Decision maker: the repository maintainer, recorded in [#2091](https://github.com/mihazs/lazysh/issues/2091) on 2026-11-18. Implementation: [#2092](https://github.com/mihazs/lazysh/issues/2092) (the engine choice in Settings), [#2093](https://github.com/mihazs/lazysh/issues/2093) (the Waydroid acceptance lane) and [#2094](https://github.com/mihazs/lazysh/issues/2094) (the Android default). The gates and stages that change are rewritten in the [migration plan](terminal-migration-plan.md#decision-of-2026-11-18-waydroid-is-the-android-acceptance-environment). The status of this ADR stays **Proposed**: this amendment changes which evidence the Android release needs, and moves no gate to met. **Decision points 3 and 4 are superseded by [Amendment 7](#amendment-7-2026-11-18-the-native-engine-is-the-default-wherever-its-surface-passes)**, recorded the same day: native is the default wherever its surface passes, not on Android only. Points 1, 2 and 5 and the accepted risks stand.

**Reason.** The plan and this ADR asked for a physical Android device for the composition gate, the IME matrix with Gboard and SwiftKey, and the performance, memory and energy gates. No physical device has been used for this program and none is available to its authors, so those gates could not be passed and no native engine could reach a user. Waydroid is installed on the development machine, its container runs, and the project's Android WebView and Canvas measurements already ran on it ([Amendment 3](#amendment-3-2026-11-13-the-webgl-addon-at-the-phone-viewport-and-under-context-loss), [Android Canvas drawing](terminal-benchmarks.md#android-canvas-drawing-of-the-shared-layout-waydroid-not-a-device)); the Android end-to-end helpers (`apps/client/mobile-e2e`, `apps/client/bench/android-apk.sh`) already know it. What bounds the unmeasured risk is that the release is reversible: by the user in Settings and by a build-time kill switch.

**Decision.**

1. The physical-device requirement is waived for the release that makes the native engine the Android default. Waydroid is the Android acceptance environment: composition (G13), input (G6), performance (G14) and memory (G15) are accepted on the Waydroid lane of [#2093](https://github.com/mihazs/lazysh/issues/2093), whose journeys, benchmarks and recorded limits are checked into `benchmarks/` on `main`. The decision rule and the [acceptance of a candidate](terminal-benchmarks.md#acceptance-of-a-candidate) apply unchanged, with Waydroid as the environment. The next measurements that Amendments 1 to 3 name on a physical device are replaced, for this release, by the lane; the energy run of [#1340](https://github.com/mihazs/lazysh/issues/1340) stays open and unmeasured.
2. The user chooses the engine in Settings (Native, xterm.js or Auto) on every platform ([#2092](https://github.com/mihazs/lazysh/issues/2092)). xterm.js stays selectable on every platform in every release.
3. *Superseded by Amendment 7 (Android flips first, the other platforms follow).* Native becomes the default on Android only, in a release of its own ([#2094](https://github.com/mihazs/lazysh/issues/2094)), after the Waydroid lane and every other agent-doable gate pass: "native is the Android default, xterm.js one setting away". The changed default is called out in the changelog and in a one-time notice.
4. *Superseded by Amendment 7 (each of these platforms flips its default when its surface passes).* iOS, macOS, Windows and Linux keep xterm.js as the default. Native is an experimental opt-in there, shown disabled with the reason until that platform's native surface ([#1330](https://github.com/mihazs/lazysh/issues/1330) iOS, [#1331](https://github.com/mihazs/lazysh/issues/1331) Linux, [#1332](https://github.com/mihazs/lazysh/issues/1332) Windows, [#1333](https://github.com/mihazs/lazysh/issues/1333) macOS) has passed its own composition, input, accessibility-or-refusal and benchmark acceptance on the CI hosts the project has, with the kill switch tested (G19, S4). Making native their default needs its own later issue and gate. The iOS composition result is a condition of iOS's opt-in, not of the Android release.
5. Removing the xterm.js code ([#1343](https://github.com/mihazs/lazysh/issues/1343), S5, G20) is not part of that release and stays gated by G20.

**Accepted risks.** What Waydroid cannot establish is recorded in every result and in the gate table as **accepted risk, not measured**. It is never reported as met, never described as a device result, and the release notes of the default flip name it:

| Not established by Waydroid | Why Waydroid cannot show it | What bounds the risk |
| --- | --- | --- |
| Battery energy (the 20 % target of G16) | The host is a desktop: there is no phone battery or power rail to attribute energy to the app. | The lane measures idle activity (frames and wakeups with nothing changing), labelled as a proxy and never as energy. Settings and the kill switch return a user to xterm.js. |
| Vendor keyboards (Gboard, SwiftKey) | The lane uses the input method available in the guest and reports which one ran; a vendor keyboard is tested only if it can be installed there. | The xterm.js IME specs keep covering the xterm.js path. Settings and the kill switch. |
| Real GPU drivers | The guest renders on the host's desktop GPU (an AMD radeonsi part in the recorded runs), not a phone driver, memory bandwidth or Vulkan or OpenGL ES stack. | The renderer reports `Unsupported` when no usable adapter exists and the design keeps xterm.js then ([wgpu crate](../../packages/terminal-renderer-wgpu/README.md)); that path is not exercised on a phone GPU. Settings and the kill switch. |
| Real touch hardware | Waydroid input is injected: no real digitizer, palm rejection, multi-touch or edge-gesture behaviour. | Gesture and selection journeys run with injected events and say so. Settings and the kill switch. |

The same limits mean that thermal behaviour, vendor ROM and WebView variation, and running the aarch64 build that ships (the Waydroid guest in the recorded runs is x86_64) are not measured either, and they are recorded the same way.

**What does not change.** Native is never the default before every agent-doable gate passes; a Waydroid pass does not waive G1 to G5, G7 to G12, G17 or G18. Evidence counts only when it is on `main`. Not measured is not met. Deleting xterm.js stays blocked by G20. This ADR may move to Accepted for the Android scope only by a later amendment that cites the lane's evidence on `main`; this amendment does not decide that.

## Amendment 7 (2026-11-18): the native engine is the default wherever its surface passes

Decision maker: the repository maintainer, recorded in [#2119](https://github.com/mihazs/lazysh/issues/2119) on 2026-11-18. Implementation: [#2092](https://github.com/mihazs/lazysh/issues/2092) (the engine choice and the default, Auto), [#2094](https://github.com/mihazs/lazysh/issues/2094) (the Android flip, which files one child issue per other platform) and, for the other platforms, [#1330](https://github.com/mihazs/lazysh/issues/1330) (iOS), [#1331](https://github.com/mihazs/lazysh/issues/1331) (Linux), [#1332](https://github.com/mihazs/lazysh/issues/1332) (Windows) and [#1333](https://github.com/mihazs/lazysh/issues/1333) (macOS) with [#1334](https://github.com/mihazs/lazysh/issues/1334) (input and selection parity), [#1335](https://github.com/mihazs/lazysh/issues/1335) (screen-reader parity or tested refusal) and [#1336](https://github.com/mihazs/lazysh/issues/1336) (capability probing). The stages, gates and release text that change are rewritten in the [migration plan](terminal-migration-plan.md#second-decision-of-2026-11-18-the-native-engine-is-the-default-wherever-its-surface-passes). The status of this ADR stays **Proposed**: this amendment changes where the default flips and in what order, and moves no gate to met. It supersedes decision points 3 and 4 of [Amendment 6](#amendment-6-2026-11-18-waydroid-is-the-android-acceptance-environment); the rest of Amendment 6 stands.

**Reason.** Amendment 6 made native the default on Android only and kept xterm.js the default on iOS, macOS, Windows and Linux until a later issue with its own gate. The maintainer has since decided that the new terminal engine must be enabled by default, not only on Android: users get the engine this program builds wherever it works, with xterm.js one setting away. The safeguards of Amendment 6 are what make that acceptable: the choice and the kill switch are reversible by the user and by a build, every default flip is its own gated release, and the registry already selects automatically only a backend registered as `autoEligible`, which is a flag a platform's native backend gets when that platform's gate passes.

**Decision.**

1. **Every platform has the engine choice** in Settings, Terminal engine: Native, xterm.js or Auto ([#2092](https://github.com/mihazs/lazysh/issues/2092)), stored per device. **The default is Auto.** xterm.js stays selectable on every platform in every release.
2. **Auto resolves to Native** on every platform where a native surface exists and passes the registry's capability probe ([#1336](https://github.com/mihazs/lazysh/issues/1336)), and **to xterm.js** where it does not. A session also uses xterm.js, on any platform:
   - when the user chose xterm.js;
   - when a screen reader is active and native lacks the `accessibility` capability (G8; the registry already refuses a backend without it);
   - after a recorded native failure.

   An explicit Native choice meets the same probe and screen-reader rules: no setting forces a native engine onto a platform or a session that fails them, as a developer override already cannot.
3. **The reason is always recorded and visible.** The registry records why a backend was or was not chosen, and Settings and the terminal's overflow menu show it ([#2092](https://github.com/mihazs/lazysh/issues/2092)). Where no usable native surface exists yet, the Native option is shown disabled with the reason ("not available on this platform yet"), never hidden, and Auto resolves to xterm.js with that reason.
4. **Android flips first** ([#2094](https://github.com/mihazs/lazysh/issues/2094)), after the Waydroid lane of [#2093](https://github.com/mihazs/lazysh/issues/2093) and every other agent-doable gate pass. **iOS, macOS, Windows and Linux flip their default as each platform passes**: its own native surface ([#1330](https://github.com/mihazs/lazysh/issues/1330), [#1331](https://github.com/mihazs/lazysh/issues/1331), [#1332](https://github.com/mihazs/lazysh/issues/1332), [#1333](https://github.com/mihazs/lazysh/issues/1333), with [#1334](https://github.com/mihazs/lazysh/issues/1334) to [#1336](https://github.com/mihazs/lazysh/issues/1336)) has to pass composition, input, accessibility-or-refusal and benchmark acceptance on the CI hosts the project has (the iOS simulator, the macOS and Windows runners, Linux under Xvfb and Wayland), with that platform's kill switch tested (G19, S4). Each flip is one default-flip pull request and one release of its own, a gated change; a platform that has not passed does not hold back one that has, and keeps xterm.js with the reason shown meanwhile.
5. **Every flip is a changed default and is called out.** The `CHANGELOG.md` `[Unreleased]` entry and the release notes say so and name what the CI hosts and Waydroid could not show. The first launch after the update shows a one-time, dismissible notice: "The terminal engine changed on this platform. Switch back in Settings, Terminal engine." A preference the user already set is not reset. The release is a minor one at least, and the on-disk format does not change.
6. **Removing the xterm.js code is not part of any flip.** [#1343](https://github.com/mihazs/lazysh/issues/1343) (S5, G20) stays gated and is untouched by this amendment.
7. **No new device requirement.** The waiver of Amendment 6 stands, with Waydroid as the Android environment and the CI hosts above as the others. What those environments cannot establish (real devices, battery energy, vendor keyboards, real GPU drivers, real touch hardware, and the Android items of the table in Amendment 6) is recorded as **accepted risk, not measured**: never reported as met, never described as a device result, and repeated in the pull request and the release notes of each flip. An item a host cannot exercise at all is not passed: that platform does not flip, and its Native option stays disabled with the reason.

**What does not change.** Native is never the default on a platform before every agent-doable gate passes for that platform, and no platform ships a partially working native renderer. A Waydroid or CI-host pass waives no other gate. Evidence counts only when it is on `main`; not measured is not met; existing tests are never weakened. Deleting xterm.js stays blocked by G20. This ADR may move to Accepted, per platform, only by a later amendment that cites that platform's evidence on `main`; this amendment does not decide that.
