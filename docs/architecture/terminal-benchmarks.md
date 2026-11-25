# Terminal benchmarks

Status: **the xterm.js baseline and the xterm.js canvas and WebGL renderer addons are measured on one desktop host, and the native candidates only by microbenchmarks (the [same-run comparison harness for the Waydroid lane](#same-run-comparison-on-the-waydroid-lane-g14-g15-g16-idle) is built and tested, and has no recorded run yet): a wgpu prototype on the host GPU (Vulkan, OpenGL and OpenGL ES backends), the Android Canvas on Waydroid and libghostty-vt as WebAssembly in Node.** No Android, iOS, Windows or macOS device has been measured, none of the native candidates is a complete renderer (no text pipeline, no window surface, no bridge), and none of their figures ranks anything on a device. The measured rows below come from the harness described in [Baseline harness](#baseline-harness-xterm-js-dom-renderer), run in headless desktop Chromium, which is **not an Android WebView**. A number may be quoted elsewhere in `docs/architecture` only if it comes from this suite, with its environment block. Tracking: harness [#1303](https://github.com/mihazs/lazysh/issues/1303), renderer shootout [#1323](https://github.com/mihazs/lazysh/issues/1323), CI regression [#1341](https://github.com/mihazs/lazysh/issues/1341), Android energy [#1340](https://github.com/mihazs/lazysh/issues/1340). Related: [PRD](terminal-performance-prd.md) · [native rendering](native-rendering.md).

## Principles

1. **Baseline before optimizing.** The first run measures the current xterm.js 5.5.0 DOM renderer and an optimized xterm.js variant (renderer addon and binary IPC); nothing else is compared until those exist. The renderer-addon half is measured ([renderer shootout](#renderer-shootout-xtermjs-renderers-1323)); the binary-IPC half is not built, only its bridge decode stage is measured in the baseline.
2. **Release builds only**, with the build configuration recorded. Debug builds are rejected by the harness.
3. **Stages are separated** so a regression can be attributed.
4. **Physical devices** for latency pacing, energy, thermal and battery. An emulator may be used for functional checks and is labelled as such; it must not be used to claim energy or thermal results.
5. **Never invent a number.** A missing capability (for example no battery counter on a device) is recorded as unavailable.
6. **Per-device decisions.** If native does not beat the fallback on a device, the faster verified implementation stays for that device and platform.

## Stage separation

| Stage | What is timed | Where | Candidate method (to be chosen when the harness is built) |
| --- | --- | --- | --- |
| Transport latency | Remote byte produced to byte available in Rust | Rust session worker | Timestamps at the read site and at `deliver_output` (`ssh.rs`) |
| Bridge | Byte available in Rust to byte available to the terminal engine | Channel, JSON decoding, `Uint8Array` copy (xterm path); queue (native path) | JS and Rust timestamps with a shared clock estimate |
| VT parse | Bytes to updated screen state | xterm parser; ghostty-vt core | Instrumented write callback; Rust microbenchmarks |
| State update | Dirty-region computation | core `RenderState`; xterm buffer | Counters |
| Renderer CPU | Time to produce draw work | main thread (DOM) or render thread | Profiler, long-task and frame timing |
| GPU frame time | Time the GPU spends on a frame | Native surface | Platform GPU timing where exposed |
| Input to presentation | Key event to pixels changed | Whole path | High-speed camera or on-device photodiode where available; otherwise an in-app marker plus display present time, labelled as an estimate |
| Frame pacing | Intervals between presented frames, dropped frames | Device | Frame timeline tooling |
| Memory | Peak and steady resident memory, per-session cost | Process | OS memory counters at fixed intervals |
| Energy | Energy per workload, battery drain | Device | OS battery statistics on a physical device |

## Workloads

Each workload has a replayable fixture, a duration, and a pass or fail correctness check (final screen text compared to an expected result).

| Id | Workload | Notes |
| --- | --- | --- |
| W0 | Idle, session open, no output, cursor blink on and off | Idle renderer activity must be near zero |
| W1 | Small shell output (prompt, short commands) | Latency |
| W2 | Sustained plain text (large file `cat`) | Throughput, CPU |
| W3 | ANSI color heavy output | Style handling |
| W4 | Cursor movement and full-screen redraw | Dirty-region efficiency |
| W5 | vim or Neovim editing session | Real TUI |
| W6 | tmux session; Zellij session | Multiplexer redraws |
| W7 | Mosh resize and reconnect | Canonical framebuffer path, `mosh-resize-frames.json` |
| W8 | Claude, Codex and OpenCode style streaming (captured streams, sanitized) | Agent TUI behaviour |
| W9 | 5 simultaneous sessions; 10 simultaneous sessions | Memory and active-session latency |
| W10 | Large scrollback (configured maximum) | Memory, scroll cost |
| W11 | Background and resume; surface recreation | Resume latency, state preservation |
| W12 | Keyboard composition and repeated input | Latency, correctness of IME commits |
| W13 | Long-running sustained workload (thermal) | Throttling, energy |

## Metrics

p50, p95 and p99 input-to-render; p50 and p95 frame time; dropped frames; CPU time; GPU frame time; idle CPU and GPU use; peak and steady memory; per-session memory; throughput; energy per workload; battery drain; startup and resume time.

## Environment block (required with every result)

Device model, SoC, RAM, OS and build, WebView implementation and version (xterm path), display refresh rate, power and battery state, brightness and radio settings, thermal state at start, toolchain versions (Rust, Zig, Gradle/NDK or Xcode), lazysh commit, build profile and flags, renderer candidate, scrollback setting, font and size, and the fixture hashes.

## Result schema

The harness writes one versioned JSON file per run and viewport (schema 1). Unmeasured fields are absent or `null`, never zero. Committed results live in [`benchmarks/`](benchmarks/).

```json
{
  "schema": 1,
  "candidate": "xterm-dom",
  "mode": "full",
  "host": { "cpu": "", "logicalCpus": 0, "ramGiB": 0, "os": "", "cpuGovernor": "", "loadAverage": { "atStart": [], "atEnd": [] } },
  "toolchain": { "bun": "", "node": "", "playwright": "", "chromium": "", "xterm": "" },
  "source": { "commit": "", "dirty": false },
  "page": { "project": "", "cols": 0, "rows": 0, "scrollback": 5000, "build": "production", "renderer": "xterm-dom", "refreshNominalMs": 0 },
  "fixtures": { "plain": { "bytes": 0, "chunks": 0, "sha256": "" } },
  "limits": "",
  "results": [
    { "workload": "W2", "title": "", "variant": null, "correct": true, "notes": "",
      "runs": [ { "throughputMiBs": 0, "ackMs": { "p50": 0, "p95": 0, "p99": 0 }, "pacing": {}, "cost": { "windowMs": 0, "mainThreadMs": {}, "processCpuMs": {}, "heapUsedMiB": 0, "rendererRssMiB": 0 } } ],
      "median": {} }
  ]
}
```

`median` is the median of every numeric leaf across `runs`; each table below also gives the minimum and maximum across runs.

## Baseline harness (xterm.js, DOM renderer)

This section is the how-to and reference for the first harness ([#1303](https://github.com/mihazs/lazysh/issues/1303)). It measures the pipeline the app ships today: `@xterm/xterm` 5.5.0 with its default DOM renderer, created by the app's own `createTerminal()` and mounted by the app's own `TerminalPane`, with the app's default preferences (`scrollback` 5000, `cursorBlink` on).

### Run it

```sh
cd apps/client
bun run bench:terminal                      # both viewports, release build, about 9 minutes
bun run bench:terminal -- --project desktop  # one viewport, about 4.5 minutes
LAZYSH_BENCH_OUT=/tmp/run.json bun run bench:terminal -- --project desktop
LAZYSH_BENCH_WRITE=adapter bun run bench:terminal -- --project desktop   # every byte through XtermTerminalAdapter.write
LAZYSH_BENCH_GRID=49x15 LAZYSH_BENCH_WRITE=adapter bun run bench:terminal -- --project desktop
LAZYSH_BENCH_PAIRED=1 bun run bench:terminal -- --project desktop -g paired   # both write paths, stream by stream, about 2 minutes
LAZYSH_BENCH_PAIRED=1 LAZYSH_BENCH_PAIRED_ROUNDS=40 LAZYSH_BENCH_PAIRED_KINDS=ansi bun run bench:terminal -- --project desktop -g paired   # more streams for one workload (plain, ansi, redraw)
```

`LAZYSH_BENCH_GRID=COLSxROWS` holds the benchmark at a known measured grid even if the viewport changes. Leave it unset for the normal pane fit. For an Android pair, use the native arm’s grid.

`bench:terminal` builds the benchmark page with `vite build -c vite.bench.config.ts` (minified, React production) and serves it with `vite preview`; the run is rejected if the page reports a non-production build. Output defaults to `apps/client/bench-results/terminal-baseline-<write path>-<viewport>.json` (git-ignored; a renderer candidate other than `dom` adds `-<candidate>` before the write path). Results worth keeping are copied to [`benchmarks/`](benchmarks/).

To measure another renderer on the same terminal, fixtures and counters, set `LAZYSH_BENCH_RENDERER=canvas` or `webgl` (default `dom`) and, to choose the GL backend, `LAZYSH_BENCH_CHROMIUM_ARGS`. `bench/compare.ts` prints several result files side by side: `bun bench/compare.ts dom=a.json webgl=b.json`.

The same spec also runs in **smoke mode** inside the normal Playwright suite (`e2e/terminal-bench.spec.ts`, desktop project only, against the dev server). Smoke mode uses tiny fixtures and asserts only that every workload completes, ends on the expected screen, and reports finite numbers. It runs both write paths and one round of the paired comparison below. It has **no timing thresholds**, so it cannot flake on a slow runner. The deterministic fixture generators and the statistics helpers have unit tests (`bench/workloads.test.ts`).

### What is simulated and what is real

| Stage | Real in the harness | Simulated or missing |
| --- | --- | --- |
| Bridge | `JSON.parse` of a `number[]` chunk and `new Uint8Array(...)`, the same decoding `SshEvent::Data` goes through, timed separately | The native IPC hop (Tauri channel, WebView message), which only a device or the real app can measure |
| Flow control | 16 KiB chunks and the 256 KiB credit window of the Rust session workers; the credit is returned in the xterm `write` callback, as the baseline did; with `?write=adapter` the bytes go through `XtermTerminalAdapter.write(bytes, onApplied)` and the credit is returned in `onApplied`, which is what `App.tsx` calls | The per-chunk `ack_output` IPC round trip is not issued |
| VT parse and state | xterm.js itself, in the page | None |
| Rendering | The app's `TerminalPane`, CSS, fit and DOM renderer in Chromium | Compositor and display present are not observed; GPU work is software on this host |
| Input | Real key events through Chromium's input pipeline (Playwright), the app's `observeTerminalInput`, the IME layer and the `write_stdin` command | The remote echo is instant (zero round trip) and shares the xterm write queue with any concurrent output |
| IME | Chromium's `Input.imeSetComposition` and `Input.insertText` | Not Gboard or SwiftKey; no Android input method is involved |
| Sessions | N xterm `Terminal` objects created by `createTerminal()`; the visible one in the real `TerminalPane`, the others opened in `display:none` panes, as `App.tsx` mounts one `TerminalPane` per session and hides the inactive ones | The background panes are minimal stand-ins, not the real `TerminalPane` (no toolbar, input layer or React tree), so per-session memory excludes those; the app was not measured with real sessions |

Every figure is a **time to the xterm render callback**, not to pixels. A keystroke latency is the in-page `event.timeStamp` of the key (or `compositionend`) to the first `onRender` after the echo has been applied. Synthetic events carry the time they were created, so OS input, driver, compositor and display latency are excluded.

### Workloads implemented

Fixtures are seeded (`bench/workloads.ts`) and sized to the terminal's geometry, so byte counts differ between viewports; their SHA-256 is recorded in each result. Every workload ends with a check that the visible screen equals the expected text; a mismatch fails the run.

| Id | Implemented as | Scale in the baseline |
| --- | --- | --- |
| W0 | Focused terminal, no output, cursor blink on and off; no page frame loop, so the page does not wake itself | 10 s, 3 runs each |
| W1 | Prompt, short command and 0 to 3 output lines per burst, one burst at a time | 300 bursts, 5 runs |
| W2 | Sustained plain text, lines one cell narrower than the terminal | 4 MiB, 5 runs |
| W3 | The same text with random 16-colour, 256-colour, truecolor and attribute sequences on every word | 2 MiB, 5 runs |
| W4 | Full-screen repaint by absolute cursor positioning with per-row colour and erase-to-end-of-line | 1500 frames, 5 runs |
| W9 | 5 and 10 sessions, each filled to the 5000-line scrollback; the other sessions stream while keys are typed into the visible one | 200 keys, 5 runs |
| W10 | 20000 lines written at scrollback 5000 and at 20000, then 100 scroll steps plus top and bottom | 5 runs |
| W12 | Real key presses one at a time with seeded jitter; auto-repeat at about 30 Hz with jitter; keys while W2 text floods the same terminal; IME composition commits | 200, 150, 200, 50; 5 runs |

Seeded jitter is used because an early probe without it phase-locked every keystroke to the 60 Hz frame clock (idle p50 of about 15 ms in that probe, which was discarded and is not part of the tables).

**Not in this baseline:** W5 to W8 and W11, which are now implemented as [program workloads](#program-workloads-w5-to-w8-and-w11) in their own spec, and W13 (thermal), which needs a device and remains open on [#1303](https://github.com/mihazs/lazysh/issues/1303). **No Rust-side parse benchmark was added here:** the baseline's VT parse runs in xterm.js, and the Rust workers only chunk bytes; the shared core's parse benchmarks are [on the baseline's own workloads](#parse-stage-on-the-baselines-own-workloads-native-core-versus-xtermjs-host-microbenchmark-not-a-device-baseline) ([#1313](https://github.com/mihazs/lazysh/issues/1313), [#1341](https://github.com/mihazs/lazysh/issues/1341)).

### Counters

Main-thread time (`Performance.getMetrics`: `TaskDuration`, `ScriptDuration`, `LayoutDuration`, `RecalcStyleDuration`, style recalculation and layout counts), per-process CPU time of the renderer, GPU and browser processes (`SystemInfo.getProcessInfo`, 10 ms resolution), JS heap after a forced garbage collection, and the page's renderer resident set from `/proc` (Linux only), all read through the Chrome DevTools Protocol around each run. In-page: write-to-ack latency per chunk, bridge decode time, `requestAnimationFrame` intervals with dropped frames (intervals above 1.5 nominal frames, counted as whole missed frames), and Long Task entries. `performance.now()` has 0.1 ms resolution here, so sub-0.1 ms values read as 0.

### Measured baseline

Environment of the committed results: AMD Ryzen 9 5900X (12 cores, 24 threads), 31 GiB RAM, Linux 7.3.1-cachyos x86_64, `powersave` CPU governor, headless Chromium 156.0.8078.4 driven by Playwright 1.64.1 under Node 26.6.0 and Bun 1.3.14, xterm.js 5.5.0 with its DOM renderer, release (minified) build of the benchmark page, software rendering. The lazysh commit is recorded in each JSON file; it is the pull-request branch commit before squash, and `dirty: true` there only reflects documentation edits that were uncommitted while the runs were taken (the benchmark code was committed). **The host is shared with other development workloads**: the 1-minute load average was between 1.1 and 1.7 at the start of the committed runs, but an earlier set of runs of the same harness, taken while it was between 3 and 12, showed slower and noisier numbers; the files record the load average. Treat the figures as a baseline for this host, not as an Android result and not as a regression threshold. Each cell is the median over five runs with min-max in parentheses; tails (p99, max, dropped frames) and W3 vary most. W3 in particular alternated between fast and slow runs (desktop throughput 2.7 to 11 MiB/s across the two committed runs) and no cause was identified.

Raw results: [desktop 1280 by 850](benchmarks/terminal-baseline-xterm-dom-desktop.json), [a repeat of the desktop run taken afterwards](benchmarks/terminal-baseline-xterm-dom-desktop-repeat.json), [phone-sized 390 by 844 at devicePixelRatio 3](benchmarks/terminal-baseline-xterm-dom-phone.json). The "phone" project is desktop Chromium with a phone viewport, device pixel ratio and touch emulation only; it runs the same desktop CPU and the same engine and is useful for the narrow-terminal geometry (46 columns), not for mobile performance.

- **desktop 1280x850**: 152 columns by 38 rows, viewport 1280 by 850 CSS px, devicePixelRatio 1, nominal frame interval 16.7 ms; 1-minute load average 1.1 at start and 1.5 at end.
- **phone 390x844 @3x**: 46 columns by 37 rows, viewport 390 by 844 CSS px, devicePixelRatio 3, nominal frame interval 16.7 ms; 1-minute load average 1.5 at start and 1.7 at end.

Streaming (W2 plain, W3 ANSI color, W4 full-screen redraw), 5 runs, median (min-max):

| Workload | Viewport | Bytes | Throughput MiB/s | Wall ms | Bridge decode ms/MiB | Write-to-ack p50 / p99 ms | Frame p99 ms | Dropped frames | Main thread task ms | Renderer CPU ms | GPU process CPU ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W2 plain | desktop | 4.00 MiB | 40.1 (37.2-40.8) | 100 (98-108) | 8.1 (7.5-8.3) | 0.20 (0.20-0.20) / 2.2 (1.6-2.3) | 16.7 (16.7-16.8) | 0 (0-0) | 112 (111-122) | 180 (170-210) | 10 (0-10) |
| W2 plain | phone | 4.00 MiB | 37.3 (33.0-37.6) | 107 (106-121) | 7.7 (7.4-8.3) | 0.20 (0.20-0.30) / 1.9 (1.7-2.0) | 16.7 (16.7-16.8) | 0 (0-0) | 121 (120-136) | 180 (160-200) | 0 (0-10) |
| W3 ANSI color | desktop | 2.00 MiB | 4.3 (3.3-10.9) | 464 (183-615) | 8.0 (7.1-9.4) | 0.30 (0.30-0.40) / 18.9 (14.3-21.4) | 16.8 (16.7-16.8) | 0 (0-0) | 528 (224-685) | 1030 (340-1470) | 30 (20-30) |
| W3 ANSI color | phone | 2.00 MiB | 22.0 (16.4-24.8) | 91 (81-122) | 9.1 (8.5-9.9) | 0.30 (0.30-0.40) / 6.2 (5.5-8.0) | 16.8 (16.7-16.8) | 0 (0-0) | 110 (98-143) | 190 (170-300) | 0 (0-10) |
| W4 redraw | desktop | 9.22 MiB | 52.1 (51.1-52.2) | 177 (177-181) | 6.9 (6.7-7.2) | 0.20 (0.20-0.20) / 1.8 (1.7-1.8) | 16.8 (16.7-16.8) | 0 (0-0) | 190 (189-200) | 240 (230-270) | 40 (30-40) |
| W4 redraw | phone | 3.37 MiB | 51.4 (47.0-51.6) | 66 (65-72) | 7.2 (6.5-7.5) | 0.20 (0.20-0.20) / 1.3 (1.2-1.6) | 16.7 (16.7-16.7) | 0 (0-0) | 77 (74-87) | 110 (90-150) | 0 (0-10) |

Latency, median (min-max) over runs of each percentile, in milliseconds from the stated event to the stated point:

| Workload | Viewport | Measured | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- |
| W1 small shell bursts | desktop | write to parsed (write callback) | 0.00 (0.00-0.00) | 0.10 (0.10-0.10) | 0.10 (0.10-0.20) | 0.20 (0.20-0.30) |
| W1 small shell bursts | phone | write to parsed (write callback) | 0.00 (0.00-0.00) | 0.10 (0.10-0.10) | 0.10 (0.10-0.20) | 0.20 (0.20-0.30) |
| W1 small shell bursts | desktop | write to next xterm render | 12.6 (12.6-12.6) | 12.7 (12.7-12.7) | 12.9 (12.8-12.9) | 15.8 (15.7-16.7) |
| W1 small shell bursts | phone | write to next xterm render | 12.6 (12.6-12.6) | 12.7 (12.7-12.8) | 12.9 (12.8-13.1) | 15.8 (15.6-16.7) |
| W12 Keyboard input, one key at a time (idle terminal) | desktop | key or commit timestamp to xterm render of the echo | 1.0 (0.8-2.4) | 15.1 (14.2-15.4) | 16.4 (16.1-16.7) | 16.8 (16.4-16.9) |
| W12 Keyboard input, one key at a time (idle terminal) | phone | key or commit timestamp to xterm render of the echo | 0.9 (0.8-3.5) | 14.3 (14.3-15.2) | 16.5 (16.3-16.7) | 17.0 (16.4-17.1) |
| W12 Keyboard auto-repeat, about 30 Hz with jitter (idle terminal) | desktop | key or commit timestamp to xterm render of the echo | 1.8 (1.1-2.6) | 15.7 (15.3-16.0) | 16.6 (16.6-17.0) | 16.8 (16.6-17.0) |
| W12 Keyboard auto-repeat, about 30 Hz with jitter (idle terminal) | phone | key or commit timestamp to xterm render of the echo | 0.8 (0.6-2.7) | 15.6 (14.4-16.2) | 16.6 (16.3-17.0) | 16.8 (16.6-17.3) |
| W12 Keyboard input during sustained output (visible terminal flooded with W2 text; echo queues behind it) | desktop | key or commit timestamp to xterm render of the echo | 15.2 (12.0-16.0) | 29.9 (29.2-31.4) | 32.0 (31.2-32.3) | 34.4 (31.5-64.1) |
| W12 Keyboard input during sustained output (visible terminal flooded with W2 text; echo queues behind it) | phone | key or commit timestamp to xterm render of the echo | 13.3 (13.1-14.3) | 29.6 (26.8-31.3) | 31.8 (31.4-32.0) | 32.6 (31.9-39.7) |
| W12 IME composition commit (CDP imeSetComposition + insertText) | desktop | key or commit timestamp to xterm render of the echo | 9.4 (9.1-9.7) | 16.2 (15.4-16.5) | 16.9 (16.1-17.3) | 17.0 (16.1-17.4) |
| W12 IME composition commit (CDP imeSetComposition + insertText) | phone | key or commit timestamp to xterm render of the echo | 8.9 (8.8-9.6) | 16.1 (15.7-16.4) | 17.0 (16.4-17.2) | 17.1 (16.8-17.5) |
| W9 5 sessions, 5000 lines each, others streaming | desktop | key timestamp to xterm render of the echo | 12.2 (11.8-12.8) | 16.7 (15.9-17.6) | 20.0 (19.0-20.5) | 21.5 (21.1-31.0) |
| W9 5 sessions, 5000 lines each, others streaming | phone | key timestamp to xterm render of the echo | 11.6 (11.5-12.8) | 15.9 (15.5-16.0) | 16.8 (16.3-18.2) | 18.5 (17.0-25.3) |
| W9 10 sessions, 5000 lines each, others streaming | desktop | key timestamp to xterm render of the echo | 12.7 (12.2-13.4) | 24.4 (22.1-24.5) | 25.6 (25.5-27.0) | 29.0 (25.6-31.6) |
| W9 10 sessions, 5000 lines each, others streaming | phone | key timestamp to xterm render of the echo | 11.0 (11.0-11.6) | 18.0 (17.5-18.7) | 20.9 (19.9-21.3) | 21.8 (20.8-22.6) |

Cost of the keyboard and multi-session windows (same runs; the window is wall time, so compare the busy fraction, not the totals):

| Workload | Viewport | Window ms | Main thread task ms | Main thread busy | Renderer CPU ms | GPU process CPU ms | Style recalcs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W12 Keyboard input, one key at a time (idle terminal) | desktop | 4566 | 229 (222-240) | 5 % | 410 (410-430) | 200 (190-210) | 403 (402-403) |
| W12 Keyboard input, one key at a time (idle terminal) | phone | 4534 | 246 (234-259) | 5 % | 420 (390-440) | 50 (50-70) | 404 (403-404) |
| W12 Keyboard auto-repeat, about 30 Hz with jitter (idle terminal) | desktop | 5065 | 137 (133-147) | 3 % | 260 (250-280) | 150 (120-150) | 303 (303-303) |
| W12 Keyboard auto-repeat, about 30 Hz with jitter (idle terminal) | phone | 5132 | 163 (152-167) | 3 % | 280 (260-290) | 50 (40-60) | 304 (304-304) |
| W12 Keyboard input during sustained output (visible terminal flooded with W2 text; echo queues behind it) | desktop | 6939 | 5553 (5322-5636) | 80 % | 6830 (6580-6960) | 350 (320-400) | 1208 (1182-1237) |
| W12 Keyboard input during sustained output (visible terminal flooded with W2 text; echo queues behind it) | phone | 6866 | 5464 (5335-5598) | 80 % | 6190 (6050-6320) | 170 (140-180) | 939 (919-948) |
| W12 IME composition commit (CDP imeSetComposition + insertText) | desktop | 183 | 78 (65-99) | 43 % | 130 (110-150) | 10 (10-10) | 259 (258-261) |
| W12 IME composition commit (CDP imeSetComposition + insertText) | phone | 182 | 86 (71-110) | 47 % | 130 (110-150) | 0 (0-10) | 261 (259-263) |
| W9 5 sessions, 5000 lines each, others streaming | desktop | 6293 | 5110 (4865-5317) | 81 % | 5770 (5500-5990) | 210 (200-230) | 403 (402-403) |
| W9 5 sessions, 5000 lines each, others streaming | phone | 6102 | 4817 (4622-4900) | 79 % | 5410 (5210-5510) | 60 (50-70) | 403 (403-404) |
| W9 10 sessions, 5000 lines each, others streaming | desktop | 7071 | 6780 (6614-7018) | 96 % | 7880 (7750-8130) | 210 (200-250) | 403 (402-403) |
| W9 10 sessions, 5000 lines each, others streaming | phone | 6758 | 5878 (5667-6114) | 87 % | 7040 (6830-7290) | 60 (50-80) | 404 (403-404) |

Idle (W0): the terminal is focused and nothing is written; no page script runs a frame loop. 3 runs:

| Variant | Viewport | Window ms | Main thread task ms | Style recalcs | Layouts | Renderer CPU ms | GPU process CPU ms | DOM mutations/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cursor blink on, focused | desktop | 10022 (10020-10026) | 54 (51-55) | 667 (666-701) | 2 (2-5) | 110 (110-120) | 20 (20-20) | 0.00 (0.00-0.00) |
| cursor blink on, focused | phone | 10022 (10021-10034) | 51 (47-55) | 682 (672-690) | 2 (2-6) | 90 (90-120) | 20 (10-20) | 0.00 (0.00-0.10) |
| cursor blink off, focused | desktop | 10023 (10022-10035) | 10 (10-11) | 2 (2-7) | 3 (3-3) | 30 (20-30) | 10 (0-10) | 0.00 (0.00-0.10) |
| cursor blink off, focused | phone | 10022 (10019-10022) | 11 (11-11) | 3 (3-6) | 3 (3-3) | 30 (30-40) | 0 (0-10) | 0.00 (0.00-0.10) |

Memory and scrolling (W10, W9), 5 runs:

| Workload | Viewport | Buffer lines kept | Fill ms | Scroll frame p99 ms | Dropped frames | JS heap MiB | Renderer RSS MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W10 scrollback 5000 lines | desktop | 5038 (5038-5038) | 331 (326-334) | 16.8 (16.8-16.8) | 0 (0-0) | 26.6 (26.5-26.7) | 195 (194-198) |
| W10 scrollback 5000 lines | phone | 5037 (5037-5037) | 332 (332-333) | 16.8 (16.8-16.8) | 0 (0-0) | 28.5 (28.5-28.5) | 185 (184-186) |
| W10 scrollback 20000 lines | desktop | 20001 (20001-20001) | 348 (347-358) | 16.8 (16.8-16.8) | 0 (0-0) | 29.6 (29.5-29.6) | 229 (228-229) |
| W10 scrollback 20000 lines | phone | 20037 (20037-20037) | 341 (340-343) | 16.8 (16.8-16.8) | 0 (0-0) | 31.4 (31.4-31.4) | 198 (197-198) |

| Workload | Viewport | JS heap per session MiB | Renderer RSS per session MiB |
| --- | --- | --- | --- |
| W9 5 sessions, 5000 lines each, others streaming | desktop | 1.05 (1.05-1.05) | 8.3 (8.3-8.3) |
| W9 5 sessions, 5000 lines each, others streaming | phone | 0.84 (0.84-0.84) | 7.2 (7.2-7.2) |
| W9 10 sessions, 5000 lines each, others streaming | desktop | 1.06 (1.06-1.06) | 7.7 (7.7-7.7) |
| W9 10 sessions, 5000 lines each, others streaming | phone | 1.15 (1.15-1.15) | 7.3 (7.3-7.3) |

### What the baseline shows, and what it does not

Each statement is about this host and these runs.

- **Bridge decoding is a measurable share of the data path.** Turning a 16 KiB `number[]` JSON chunk into a `Uint8Array` took about 7 to 9 ms per MiB. For W2 that is about 32 ms of the roughly 100 ms the 4 MiB drain took, before xterm parses a byte. This supports, but does not prove for Android, the hypothesis behind [#1315](https://github.com/mihazs/lazysh/issues/1315); it excludes the native IPC hop, which was not measured.
- **Plain text and full-screen redraws parse fast; colour at 152 columns does not.** W2 ran at about 40 MiB/s and W4 at about 52 MiB/s with no dropped frames and no long tasks. W3 ran at a median of about 4 MiB/s on the wide terminal (2.7 to 11 across both desktop runs) with up to 685 ms of main-thread time for 2 MiB, against 112 ms for 4 MiB of plain text. At 46 columns the same generator ran at about 22 MiB/s. The cost therefore depends on the number of cells per row and styles; the two viewports use different byte counts and are not directly comparable. Which part of xterm accounts for it was not isolated.
- **The enabled cursor blink keeps the page busy at idle.** With blink on, the focused idle terminal performed about 67 to 70 style recalculations per second and used about 50 to 55 ms of main-thread time and about 90 to 110 ms of renderer-process CPU per 10 s; with blink off it performed 2 to 7 recalculations in 10 s, about 10 ms of main-thread time and about 30 ms of renderer CPU. DOM mutations were zero in both, so the work is style-only; the mechanism (a CSS animation) was not isolated here. Idle on an Android WebView was not measured, so the "near-zero idle" target cannot be judged on Android from this.
- **Input echo is bound by the frame clock.** On an idle terminal a key's echo reached xterm's render callback with a median of about 1 to 2 ms and p95 about 15 ms, p99 about 16.5 ms. The bimodal shape comes from where the key lands in the 16.7 ms frame; the low median was not investigated further, so these values are only comparable with other runs of this harness. With sustained output in the same terminal the median was about 15 ms and p95 about 30 ms, with the main thread 80 % busy. With 5 and 10 mounted sessions streaming at full rate in the background (a harsher load than real use), the visible session's echo had a median of about 12 ms, p95 of 17 and 24 ms, and the main thread was 81 % and 96 % busy.
- **Memory per background session** was about 0.8 to 1.2 MiB of JS heap and 7 to 8 MiB of renderer resident memory (all five-run medians; opened xterm terminals in hidden panes, five and ten sessions, at both geometries). Raising the scrollback from 5000 to 20000 lines added about 3 MiB of JS heap and about 34 MiB of resident memory on the desktop viewport (about 13 MiB on the phone viewport). The JS heap figure may not include typed-array backing stores, so the resident-set figure is the more complete one; it is the whole renderer process delta and not only terminal data.
- **Scrolling a full buffer did not drop frames** in these runs (W10, frame p99 about 16.8 ms, 0 dropped), at both scrollback sizes.
- **IME commits were not duplicated or lost** in the Chromium composition protocol (every commit produced exactly one remote write); this says nothing about Gboard or SwiftKey.

Not shown by this baseline: anything about Android, WebView, a real GPU, energy, thermal behaviour, a real network, real remote echo, the app's full React tree, or the other workloads listed above.

### Write path: xterm `write` directly versus `XtermTerminalAdapter.write` ([#1306](https://github.com/mihazs/lazysh/issues/1306))

`App.tsx` feeds every chunk through `XtermTerminalAdapter.write(bytes, onApplied)`, which wraps xterm's `write(bytes, callback)` in a Promise and a pending-set entry so a dispose can reject it. The baseline above calls xterm's `write` directly, so it cannot see that wrapper. `?write=adapter` (`LAZYSH_BENCH_WRITE=adapter`) sends every byte of every workload through the adapter instead; the run fails if a run that claims the adapter path made no adapter write, or the other way round. Nothing else differs between the two modes: same terminal, `TerminalPane`, fixtures, credit window and counters.

Two comparisons were taken on the same host as the baseline (AMD Ryzen 9 5900X, headless Chromium 156.0.8078.4, Playwright 1.64.1, Bun 1.3.14, Linux 7.3.3-1-cachyos, `powersave` governor, xterm.js 5.5.0 DOM renderer, desktop 1280 by 850, release build). **The host was shared and busy: the 1-minute load average was between 3 and 25 during these runs, against 1.1 to 1.7 for the committed baseline**, so none of these figures is comparable with the baseline tables above (direct W2 here is about 33 MiB/s against about 40 there); only the direct and adapter columns of this section are comparable with each other.

**Alternating full runs.** Ten full desktop runs in the order direct, adapter, adapter, direct, direct, adapter (runs 1 to 6) and adapter, direct, direct, adapter (runs 7 to 10), each a complete [workload set](#workloads-implemented) at the baseline's scale (five runs per workload, three for idle; the table gives the median over the files of each file's five-run median, then the minimum and maximum of those file medians). The ten files are `benchmarks/terminal-write-path-run01-direct-desktop.json` to `run10`; their load averages are recorded in each. Runs 1 to 4 were taken at a 1-minute load of 12 to 25, so pooling all ten says more about the host than about the adapter: W2 33.0 against 27.5 MiB/s and W3 1.40 against 0.87, driven by adapter file medians of 6.7 MiB/s (run 2, load 14 to 25) and 0.54 MiB/s for W3 (run 3, load 22 to 24). The table below therefore uses the six runs 5 to 10, the ones whose 1-minute load average stayed at or below 12 at both start and end (a rule chosen after seeing the results, not before; the pooled rows are in the raw files): three direct and three adapter.

| Measured (median of the three file medians; min-max) | xterm `write` directly | `XtermTerminalAdapter.write` | Adapter / direct |
| --- | --- | --- | --- |
| W2 plain text throughput, MiB/s | 33.4 (33.0-36.7) | 35.1 (27.5-35.6) | 1.05 |
| W2 write-to-ack p99, ms | 2.6 (2.5-2.6) | 2.6 (2.5-3.5) | 1.00 |
| W2 main-thread task time, ms | 136 (124-138) | 129 (129-167) | 0.95 |
| W3 ANSI colour throughput, MiB/s | 1.50 (1.40-1.85) | 1.17 (0.87-1.46) | 0.78 |
| W3 main-thread task time, ms | 1445 (1188-1534) | 1800 (1444-2409) | 1.24 |
| W4 redraw throughput, MiB/s | 44.4 (43.3-46.5) | 44.2 (37.9-46.7) | 1.00 |
| W4 main-thread task time, ms | 223 (213-230) | 226 (215-263) | 1.02 |
| W1 write to render p50, ms | 12.6 (12.6-12.6) | 12.6 (12.6-12.6) | 1.00 |
| W12 key to render p50, one key at a time, ms | 1.65 (1.65-1.70) | 1.55 (1.50-1.90) | 0.94 |
| W12 key to render p95, one key at a time, ms | 15.4 (15.4-15.6) | 15.4 (15.1-15.4) | 1.00 |
| W12 key to render p95 during sustained output, ms | 29.6 (29.5-30.6) | 29.8 (29.6-29.9) | 1.01 |
| W12 IME commit to render p95, ms | 16.0 (15.8-16.2) | 16.2 (15.8-16.4) | 1.01 |
| W9 10 sessions, key to render p95, ms | 21.9 (20.4-22.2) | 22.1 (21.7-23.0) | 1.01 |
| W9 resident memory per background session, MiB | 7.6 (7.3-7.7) | 7.3 (7.3-7.5) | 0.96 |
| W10 fill 20000 lines at scrollback 20000, ms | 367 (364-370) | 372 (367-373) | 1.01 |
| W10 JS heap at scrollback 20000, MiB | 34.8 (34.6-35.1) | 35.0 (34.8-35.0) | 1.00 |
| W10 renderer resident memory at scrollback 20000, MiB | 196 (186-238) | 194 (193-239) | 0.99 |
| W0 idle, cursor blink on, main-thread task per 10 s, ms | 111 (72-129) | 92 (80-133) | 0.83 |

**Paired streams.** Because drift between two full runs is larger than the effect being looked for, `e2e/terminal-bench.spec.ts` also has a paired test (`LAZYSH_BENCH_PAIRED=1`, `-g paired`): it loads the page once per stream and alternates the write paths direct, adapter, adapter, direct, direct, ... for 12 streams of each, over W2 (4 MiB plain), W3 (2 MiB ANSI) and W4 (1500 redraw frames), so neighbouring streams share the load. Two runs, one after the other, files `benchmarks/terminal-write-paired-run1-desktop.json` (load average 16.6 at start and 10.2 at end; taken before the paired test was committed, so `source.commit` is its parent and `dirty` is true) and `...-run2-desktop.json` (8.8 and 8.8, clean tree, commit recorded). Median of 12 streams, MiB/s and ack p99 in ms. Run 3, `...-ansi-run3-desktop.json`, repeats only W3 with 40 streams per path (`LAZYSH_BENCH_PAIRED_ROUNDS=40 LAZYSH_BENCH_PAIRED_KINDS=ansi`), because W3 was the noisy one; it ran at a 1-minute load of 8 to 20 (hence the lower absolute throughput), clean tree, commit recorded:

| Stream | Run | Direct MiB/s | Adapter MiB/s | Adapter / direct | Direct ack p99 | Adapter ack p99 |
| --- | --- | --- | --- | --- | --- | --- |
| W2 plain | 1 | 29.0 | 28.4 | 0.98 | 3.60 | 3.66 |
| W2 plain | 2 | 31.2 | 32.3 | 1.03 | 3.12 | 3.04 |
| W3 ANSI | 1 | 1.32 | 1.40 | 1.06 | 29.2 | 27.3 |
| W3 ANSI | 2 | 1.58 | 1.39 | 0.88 | 29.1 | 27.3 |
| W4 redraw | 1 | 43.2 | 44.1 | 1.02 | 2.35 | 2.21 |
| W4 redraw | 2 | 44.2 | 42.4 | 0.96 | 2.16 | 2.21 |
| W3 ANSI, 40 streams per path | 3 | 0.98 | 1.02 | 1.04 | 40.7 | 40.8 |

What this shows and what it does not:

- **No difference that exceeds the noise was measured.** The paired ratios for the same stream land on both sides of 1.00 between two consecutive runs (W3: 1.06 then 0.88), the min-max ranges of the two paths overlap in every row of the table above, and a throwaway script of the same design (not committed, taken before the two runs above at a load of 3.5 to 10) gave 1.00, 1.24 and 1.01 for W2, W3 and W4. The resolution of this method on this host is therefore about 20 percent for W3, whose stream-to-stream range is 1.0 to 2.3 MiB/s even in one session, and about 5 percent for W2 and W4.
- **A third, W3-only paired run did not tighten the answer much.** 40 streams per path gave an adapter / direct throughput ratio of 1.04 (bootstrap 95 percent interval 0.84 to 1.33 for the ratio of medians; the median of the 20 neighbour-block ratios is 1.05, interval 0.91 to 1.20, both computed from the committed file with a throwaway script), and the same ack p99. It shows no cost, but at this load its interval still reaches 20 percent either way.
- **W3 is the one workload where the quieter alternating runs lean the other way** (adapter 0.78 of direct on throughput, 1.24 times the main-thread time), and the paired runs do not reproduce that. This method cannot rule out a W3 cost of up to about 20 percent; it can only say that none was seen consistently. The adapter adds per chunk one Promise and one pending-set insertion and removal. W2 pushes its 256 chunks in about 130 ms and its paired ratios stay within 0.98 to 1.03, so a per-chunk cost above roughly 0.03 ms would have shown there; W3 sends 128 chunks over a stream about ten times longer, where that cost is about 0.3 percent, so it cannot explain a gap of 20 percent. This is an inference from the W2 bound, not a W3 measurement.
- **Memory is unchanged**: per-session heap 1.06 MiB in every run of both paths, resident memory per background session and at scrollback 20000 within the range of the direct runs.
- **Input latency is unchanged**: key to render, IME commit and key during sustained output differ by at most 0.2 ms between the medians of the quieter runs.
- **Not measured:** Android WebView, a real device, the native IPC hop, the app's React tree on top of the terminal (this harness mounts `TerminalPane` but not `App`), the other renderers with the adapter, any workload outside W0 to W4, W9, W10 and W12. A slower CPU makes a fixed per-chunk cost a larger share of a chunk; only a device run settles that.
- **Provenance of the ten alternating files:** they were taken with the harness at the commit before it was rebased on [#1479](https://github.com/mihazs/lazysh/pull/1479) (`source.commit` `3dcfc640`, which is not in `main`'s history; `dirty: true` because an untracked Playwright config for a local smoke run sat in the working tree). The write-path code is the same; the only harness difference since is the renderer-candidate option, whose default is `dom`.

### Renderer shootout: xterm.js renderers ([#1323](https://github.com/mihazs/lazysh/issues/1323))

The harness above, unchanged, on the same terminal with a different renderer: the DOM renderer (the baseline), the `@xterm/addon-canvas` 0.7.0 renderer and the `@xterm/addon-webgl` 0.18.0 renderer (both devDependencies of the benchmark only; the app does not load them). The driver refuses a run in which the chosen renderer is not drawing (canvas layers must exist for canvas and WebGL and for nothing else) or in which a WebGL context was lost, because a lost context silently falls back to the DOM renderer. WebGL ran twice: with Chromium's default headless backend, which on this host is the SwiftShader software rasterizer, and with `LAZYSH_BENCH_CHROMIUM_ARGS='--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --enable-gpu --disable-vulkan-surface'`, which selects the host's AMD Radeon RX 5500 XT through RADV (the GL renderer string is recorded in `page.gl` of each file). The canvas renderer ran with and without those flags. The correctness check (final screen text equal to the fixture's expected text) passed in every run of every candidate.

Environment: the one of the [baseline](#measured-baseline) (AMD Ryzen 9 5900X, 31 GiB, Linux 7.3.3, `powersave` governor, headless Chromium 156.0.8078.4, Playwright 1.64.1, xterm.js 5.5.0, release build of the page, desktop viewport 152 columns by 38 rows at devicePixelRatio 1, 5 runs per workload and 3 for idle), with these differences: the host also ran other builds and agents, so the load average at the start of an invocation was between 2 and 14 on 24 threads (recorded per file), and the GPU was shared with that work. The runs were taken on 2026-11-12 in this order: DOM, canvas, WebGL software GL, WebGL hardware GL, DOM again; then canvas with GPU flags, WebGL hardware GL, DOM a third time, WebGL hardware GL a third time. DOM and WebGL hardware GL were taken three times each, so the cells below give the median of the three invocation medians and, in parentheses, their lowest and highest. The `commit` in each file is the base the working tree was on; `dirty` is true because the harness changes of this change were uncommitted (`a594aa69` for six runs, `9d7fb305` for the three later ones; the commits differ only in chat interaction cards, their i18n strings, agent transcript code and documentation, none of which the benchmark page renders). Raw files: `benchmarks/terminal-shootout-*.json`.

**W2 plain text, 4 MiB**

| Metric | DOM (3 invocations) | WebGL, hardware GL (3) | WebGL, software GL (1) | Canvas, default flags (1) | Canvas, GPU flags (1) |
|---|---|---|---|---|---|
| MiB/s through `xterm.write` | 36.1 (35.6-36.6) | 37.3 (36.9-40.7) | 0.26 | 1.27 | 2.28 |
| main thread task ms | 126 (122-127) | 120 (110-121) | 15505 | 3196 | 1815 |
| renderer process CPU ms | 210 (200-210) | 180 (170-180) | 860 | 3460 | 1970 |
| GPU process CPU ms | 10.0 (10.0-10.0) | 0.00 (0.00-10.0) | 240570 | 240 | 860 |
| frame interval p99 ms | 16.7 (16.7-16.7) | 16.7 (16.7-16.7) | 83.4 | 33.3 | 16.8 |
| dropped frames | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) | 698 | 3.00 | 1.00 |

**W3 ANSI color, 2 MiB**

| Metric | DOM (3 invocations) | WebGL, hardware GL (3) | WebGL, software GL (1) | Canvas, default flags (1) | Canvas, GPU flags (1) |
|---|---|---|---|---|---|
| MiB/s through `xterm.write` | 2.15 (1.57-2.19) | 6.43 (6.07-7.83) | 0.22 | 0.95 | 1.13 |
| main thread task ms | 1004 (986-1374) | 346 (292-369) | 9244 | 2321 | 1958 |
| renderer process CPU ms | 2080 (2060-2850) | 530 (480-580) | 1340 | 3300 | 2410 |
| GPU process CPU ms | 60.0 (60.0-80.0) | 420 (310-440) | 134950 | 120 | 1990 |
| frame interval p99 ms | 33.3 (33.3-33.3) | 165 (116-197) | 100 | 33.4 | 133 |
| dropped frames | 2.00 (2.00-5.00) | 19.0 (13.0-21.0) | 428 | 35.0 | 90.0 |

**W4 full-screen redraw**

| Metric | DOM (3 invocations) | WebGL, hardware GL (3) | WebGL, software GL (1) | Canvas, default flags (1) | Canvas, GPU flags (1) |
|---|---|---|---|---|---|
| MiB/s through `xterm.write` | 47.0 (43.9-51.0) | 48.6 (46.7-49.9) | 0.24 | 1.67 | 1.02 |
| main thread task ms | 211 (194-229) | 219 (218-238) | 39836 | 5949 | 9685 |
| renderer process CPU ms | 270 (240-290) | 330 (320-360) | 2550 | 7290 | 11870 |
| GPU process CPU ms | 40.0 (40.0-50.0) | 10.0 (10.0-20.0) | 624000 | 340 | 5820 |
| frame interval p99 ms | 16.7 (16.7-16.7) | 16.7 (16.7-16.7) | 83.4 | 33.4 | 33.4 |
| dropped frames | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) | 1799 | 23.0 | 67.0 |

**W0 idle, cursor blink on, 10 s**

| Metric | DOM (3 invocations) | WebGL, hardware GL (3) | WebGL, software GL (1) | Canvas, default flags (1) | Canvas, GPU flags (1) |
|---|---|---|---|---|---|
| main thread task ms | 71.8 (62.3-89.1) | 23.2 (22.1-26.2) | 58.4 | 44.7 | 20.2 |
| style recalculations | 654 (640-675) | 0.00 (0.00-0.00) | 0.00 | 0.00 | 0.00 |
| renderer process CPU ms | 160 (120-180) | 70.0 (70.0-80.0) | 60.0 | 80.0 | 60.0 |
| GPU process CPU ms | 30.0 (20.0-30.0) | 20.0 (20.0-20.0) | 140 | 10.00 | 20.0 |

**W0 idle, cursor blink off, 10 s**

| Metric | DOM (3 invocations) | WebGL, hardware GL (3) | WebGL, software GL (1) | Canvas, default flags (1) | Canvas, GPU flags (1) |
|---|---|---|---|---|---|
| main thread task ms | 13.2 (11.9-19.3) | 13.3 (13.2-13.3) | 15.4 | 17.3 | 12.5 |
| style recalculations | 2.00 (2.00-2.00) | 0.00 (0.00-0.00) | 0.00 | 0.00 | 0.00 |
| renderer process CPU ms | 40.0 (40.0-40.0) | 40.0 (40.0-50.0) | 40.0 | 50.0 | 30.0 |
| GPU process CPU ms | 10.00 (0.00-10.00) | 0.00 (0.00-10.0) | 20.0 | 10.0 | 0.00 |

**W12 keys during sustained output (echo queues behind the flood)**

| Metric | DOM (3 invocations) | WebGL, hardware GL (3) | WebGL, software GL (1) | Canvas, default flags (1) | Canvas, GPU flags (1) |
|---|---|---|---|---|---|
| p50 ms | 15.2 (14.7-15.3) | 14.5 (14.3-14.6) | 66.0 | 25.0 | 26.4 |
| p95 ms | 30.0 (29.9-30.1) | 30.7 (30.7-30.9) | 86.3 | 45.8 | 50.0 |
| p99 ms | 31.7 (31.6-31.8) | 32.5 (32.5-32.6) | 135 | 56.6 | 59.4 |

**W12 IME composition commit**

| Metric | DOM (3 invocations) | WebGL, hardware GL (3) | WebGL, software GL (1) | Canvas, default flags (1) | Canvas, GPU flags (1) |
|---|---|---|---|---|---|
| p50 ms | 8.85 (8.75-9.10) | 8.80 (8.70-10.4) | 5.95 | 8.40 | 8.45 |
| p95 ms | 15.7 (15.7-15.9) | 16.2 (16.2-20.8) | 16.5 | 14.8 | 15.7 |
| p99 ms | 16.9 (16.9-16.9) | 17.0 (16.8-25.7) | 17.5 | 17.6 | 16.4 |

**W10 scrollback 5000 lines**

| Metric | DOM (3 invocations) | WebGL, hardware GL (3) | WebGL, software GL (1) | Canvas, default flags (1) | Canvas, GPU flags (1) |
|---|---|---|---|---|---|
| JS heap MiB | 32.1 (31.9-32.1) | 46.1 (45.5-46.2) | 102 | 100 | 95.2 |
| renderer RSS MiB | 201 (153-202) | 219 (217-225) | 383 | 423 | 285 |
| scroll frame p99 ms | 16.8 (16.8-16.8) | 16.8 (16.8-16.8) | 33.4 | 16.8 | 16.8 |

**W9 10 sessions, others streaming**

| Metric | DOM (3 invocations) | WebGL, hardware GL (3) | WebGL, software GL (1) | Canvas, default flags (1) | Canvas, GPU flags (1) |
|---|---|---|---|---|---|
| p50 ms | 12.0 (11.6-12.2) | 8.15 (8.05-8.20) | 7.30 | 7.95 | 8.25 |
| p99 ms | 25.4 (25.3-27.7) | 16.2 (16.1-16.2) | 16.3 | 16.1 | 16.0 |
| renderer RSS per session MiB | 7.64 (7.29-7.67) | 6.75 (6.53-6.81) | 32.1 | 10.4 | 7.26 |

#### What the renderer shootout shows, and what it does not

Each statement is about this host, headless Chromium and these runs.

- **The canvas addon is far slower than the DOM renderer here.** W2 and W4 ran at 1.0 to 2.3 MiB/s (one invocation per flag set) against 36 and 47 MiB/s, with and without GPU flags; echo latency during sustained output had a median of 25 to 26 ms and p99 of 57 to 59 ms against 15 and 32 ms. Its cause was not isolated.
- **WebGL on a software rasterizer is unusable and costs a great deal of CPU.** At 0.22 to 0.26 MiB/s the GPU process used 135 to 624 s of CPU in the streaming workloads. A device whose WebGL context is backed by software must keep the DOM renderer, which makes capability detection ([#1336](https://github.com/mihazs/lazysh/issues/1336)) a precondition of any WebGL path. Whether Android WebViews on real devices ever report a software context was not measured.
- **WebGL on a hardware GPU matches the DOM renderer on plain text and redraws, and is much cheaper on style-heavy output.** The median W2 and W4 throughput of the three WebGL invocations is within 4 % of the DOM one. On W3 (ANSI colour at 152 columns) the three DOM invocations ran at 1.6 to 2.2 MiB/s and used 2.1 to 2.9 s of total process CPU; the three WebGL invocations ran at 6.1 to 7.8 MiB/s and used 0.8 to 1.0 s (all processes; computed from the raw files). W3 throughput on WebGL varied between 2.5 and 28 MiB/s across the individual runs of one invocation, so that figure is a median of an unstable quantity.
- **WebGL's cost is in frame pacing and fixed memory.** The W3 frame interval p99 rose from 33 ms to 116 to 197 ms and dropped frames from 2 to 5 up to 13 to 21; in the first WebGL invocation four of the five runs had a frame interval p99 of 97 ms or more. W4 total process CPU (all processes) was 0.33 to 0.39 s against 0.28 to 0.34 s, about 10 % higher at the median. The JS heap rose by about 14 MiB (46 against 32 MiB at W10) and the renderer resident set by about 8 to 12 % (217 to 225 against 201 to 202 MiB; one DOM invocation reported 153 MiB, which was not investigated). The first WebGL invocation also had a slow IME p95/p99 (20.8 and 25.7 ms against 16.2 and 16.8 to 17.0 ms in the repeats), taken at a load average of 12 to 14.
- **Idle is cheaper with WebGL and canvas while the cursor blinks.** With blink on, the DOM page performed 640 to 675 style recalculations and 62 to 89 ms of main-thread time per 10 s; WebGL performed none and 22 to 26 ms. With blink off there was no difference in main-thread time or renderer CPU.
- **Input latency is not worse.** Idle keystrokes and IME commits are within the frame-quantization spread of the DOM runs. During sustained output WebGL's p50 was lower by about 0.7 ms and its p95 and p99 higher by about 0.7 to 0.9 ms (2 to 3 %, the same direction in all three invocations; a frame is 16.7 ms). With ten sessions mounted and streaming, the typing session's echo p50 was 8.1 ms against 12.0 and its p99 16.2 against 25.4 ms, for every non-DOM renderer, which the harness does not explain.
- **Per-session memory did not grow.** With ten sessions, background sessions (hidden panes) cost 6.5 to 6.8 MiB of renderer resident memory each with WebGL against 7.3 to 7.7 with the DOM renderer (with five, 7.6 to 7.8 against 7.3 to 8.0); the fixed cost above applies once per page.
- **The custom bold color seam does not survive a renderer change.** `terminalBold.ts` reaches into the DOM renderer's row factory. Run on the live terminal in smoke runs of the same harness (not part of the raw files above, which predate the probe), `configureTerminalBold` applied on the DOM renderer and was refused with "This terminal cannot apply custom bold colors." on both the canvas and the WebGL renderer. Adopting either renderer needs another mechanism for that preference.

#### WebGL at the phone viewport, and its first ANSI-heavy burst ([#1323](https://github.com/mihazs/lazysh/issues/1323))

The same harness and the same flags as the hardware-GL runs above, on the `phone` project (viewport 390 by 844 CSS px, devicePixelRatio 3, 46 columns by 37 rows, touch emulation; a viewport emulated in desktop Chromium, not a phone). DOM and WebGL addon (hardware GL, RX 5500 XT through RADV) were each run twice, alternating DOM, WebGL, DOM, WebGL, on 2026-11-13 from a clean committed tree (`dirty` is false in every file; load average at the start of an invocation 6 to 15). Raw files: `benchmarks/terminal-shootout-xterm-dom-phone.json`, `-dom-repeat-phone.json`, `-webgl-hw-phone.json`, `-webgl-hw-repeat-phone.json`. Every workload ended on the expected screen in all four invocations (14 results each). The cells give the two invocations (first / second); medians are the harness's median over five runs unless a row says otherwise.

| Metric | DOM | WebGL, hardware GL |
|---|---|---|
| W2 MiB/s through `xterm.write` | 33.3 / 20.8 | 32.9 / 38.2 |
| W2 total process CPU ms (median of 5 runs, all processes) | 230 / 340 | 240 / 190 |
| W3 MiB/s | 17.9 / 17.4 | 25.0 / 30.4 |
| W3 total process CPU ms (median of 5 runs) | 270 / 260 | 500 / 400 |
| **W3 first run**: MiB/s | 11.6 / 11.1 | **0.26 / 0.30** |
| **W3 first run**: total process CPU ms | 380 / 460 | **15050 / 12700** |
| **W3 first run**: dropped frames, frame interval p99 ms | 1, 32 / 0, 17 | **343, 117 / 285, 114** |
| W3 runs 2 to 5: dropped frames, frame interval p99 ms | 0, 16.7 to 16.8 (all 8 runs) | 0, 16.7 to 16.8 (all 8 runs) |
| W4 MiB/s | 43.9 / 43.7 | 42.5 / 44.6 |
| W4 total process CPU ms (median of 5 runs) | 150 / 130 | 310 / 270 |
| W0 idle, cursor blink on, 10 s: main thread task ms, style recalculations | 134, 626 / 165, 612 | 29.4, 0 / 27.5, 0 |
| W0 idle, cursor blink on: renderer process CPU ms | 230 / 290 | 80 / 70 |
| W0 idle, cursor blink off: main thread task ms | 15.1 / 18.2 | 19.5 / 12.3 |
| W12 one key at a time: p50, p99 ms | 2.10, 16.7 / 2.35, 17.0 | 2.20, 17.4 / 1.70, 16.7 |
| W12 keys during sustained output: p50, p99 ms | 14.1, 31.5 / 14.4, 31.6 | 13.9, 32.2 / 13.8, 32.2 |
| W12 IME commit: p50, p99 ms | 9.10, 17.2 / 9.00, 17.4 | 9.70, 17.8 / 9.40, 17.4 |
| W9 5 sessions: echo p50, p99 ms | 12.0, 16.4 / 12.3, 16.6 | 8.70, 16.5 / 8.40, 16.2 |
| W9 10 sessions: echo p50, p99 ms | 11.1, 19.8 / 11.1, 19.4 | 7.35, 16.2 / 7.40, 15.7 |
| W9 renderer RSS per session MiB (5 sessions; 10 sessions) | 6.89, 7.52 / 7.25, 7.22 | 7.46, 6.61 / 8.37, 6.74 |
| W10 5000 lines: JS heap MiB; renderer RSS MiB | 31.6; 182 / 31.7; 191 | 54.3; 213 / 53.8; 171 |
| Custom bold color seam (`configureTerminalBold`) | applied | refused (all four invocations) |

What this adds, for this host and viewport:

- **The desktop frame-pacing regression is not the steady state at the phone size; the cold first ANSI-heavy burst is the problem.** In both WebGL invocations the first of the five W3 runs took 6.7 to 7.7 s of wall time and used 12.7 to 15.1 s of CPU (renderer process 8.1 to 9.6 s, GPU process 4.6 to 5.4 s, 57 to 79 long tasks, 285 to 343 dropped frames) for the same 2 MiB, against 66 to 82 ms and 0.35 to 0.52 s in runs 2 to 5 of the same page, which paced like the DOM renderer. The five runs replay the same bytes, so the difference is state, not input. The next section isolates what it follows. The harness reports the median of five runs, which hides it: the figures above come from the first entry of `runs` in the raw files. The desktop runs show the same shape at another size (per-run W3 throughput 2.5, 11.7, 5.6, 28 and 6.1 MiB/s in the first desktop invocation, with the same pattern in the two repeats), so the desktop "regression" was also state-dependent across runs, not a constant cost. The DOM renderer's W3 runs ranged from 11.1 to 18.5 MiB/s over its ten runs, none of them near the 0.26 to 0.30 MiB/s of the WebGL first runs.
- **At the phone size WebGL's steady-state CPU on streaming output is higher, not lower.** Total process CPU for the median W3 run was 400 to 500 ms against 260 to 270 and for W4 270 to 310 ms against 130 to 150 (1.5 to 2.1 times, a difference of 0.14 to 0.23 s per workload). On the 152-column desktop grid WebGL was cheaper on W3 (0.8 to 1.0 s against 2.1 to 2.9 s). Which side of the crossover a device is on depends on the grid and the host, so this is not an Android prediction.
- **WebGL is still cheaper at idle with a blinking cursor** (27 to 29 ms of main-thread time and no style recalculations per 10 s against 134 to 165 ms and 612 to 626), the one place its advantage held on both viewports. With the cursor not blinking the two are equal.
- **Echo latency with several sessions mounted and streaming is lower with WebGL** (p50 8.4 to 8.7 ms against 12.0 to 12.3 with five sessions and 7.35 to 7.40 against 11.1 with ten; p99 15.7 to 16.2 against 19.4 to 19.8 with ten). As in the desktop runs it holds for every non-DOM renderer and the harness does not explain it. Idle keystrokes, sustained-output echo and IME commits are equal within one frame (the p99 of sustained-output echo is 2 % higher with WebGL again).
- **The fixed memory cost is the JS heap** (about 22 MiB more at W10, in both invocations); the resident-set figures overlap between the renderers (171 to 213 against 182 to 191), and per-session resident memory does not separate them (6.6 to 8.4 against 6.9 to 7.5).
- **The bold-color seam is refused by WebGL here too**, as on desktop.

#### The first-burst stall follows the number of new visible cells ([#1323](https://github.com/mihazs/lazysh/issues/1323))

`e2e/terminal-first-burst.spec.ts` (`bun run bench:terminal terminal-first-burst`; its smoke mode runs in the normal Playwright suite and asserts completion and correctness only) streams seeded words on a **fresh page** three times, for the DOM renderer and the WebGL addon (hardware GL, same flags as above), with a chosen number of distinct styles from one family: 24-bit foregrounds, 256-color foregrounds, 256-color foreground and background, bold/italic/underline combinations over indexed foregrounds, and each of the four style families W3 mixes. The number of distinct **visible cells** (character, foreground, background, attributes) is counted offline by `bench/glyphPairs.ts` with the real xterm.js parser (`@xterm/headless` 5.5.0) over the screen after every 16 KiB chunk, which is what a glyph cache has to draw once if every chunk is rendered; SGR attributes accumulate until reset, so this is not the number of distinct SGR sequences (the `distinctGlyphs` field of the raw files is that static count of (SGR, character) pairs: an upper bound for single-family streams and not meaningful for W3, which has none). W3 itself runs at 0.5, 1, 2 and 4 MiB. The *unpaced* rows use the harness's streaming (the page parses ahead, so a pass renders 1 to 60 times, and the cold pass renders more often than the warm ones because it is slower); the *paced* rows wait one frame after each 16 KiB chunk, so every pass renders the same 66 or 130 times and cold and warm are comparable. Two invocations on 2026-11-13 per viewport from a clean committed tree (`dirty` false; load average 6.5 to 7.7 at the end): `benchmarks/terminal-first-burst-xterm-phone.json`, `-repeat-phone.json`, `-desktop.json` and `-repeat-desktop.json`. Every pass of every row ended on the expected screen and no WebGL context was lost. Cells are the two invocations. CPU is the total of all browser processes for the pass.

**WebGL addon, phone viewport (46 by 37 cells at devicePixelRatio 3), unpaced**

| Stream | Distinct visible cells | Cold pass: CPU ms / wall ms / dropped frames | Warm passes: CPU ms / wall ms |
|---|---|---|---|
| 1 style (24-bit) | 26 | 150-160 / 47 / 0 | 70-85 / 30 |
| 8 colors (palette16) | 208 | 230-240 / 80-87 / 0 | 90-95 / 34 |
| 8 bold/underline | 208 | 270-280 / 103 / 0 | 135-150 / 41 |
| 8 attribute combinations | 208 | 300-330 / 109-119 / 1 | 150 / 42-46 |
| 64 bright foreground on background | 1,664 | 470-480 / 222-229 / 5-6 | 115 / 35-38 |
| 32 24-bit | 832 | 340-390 / 140 / 3 | 90-95 / 33-36 |
| 256 24-bit | 6,558 | 1,320-1,370 / 679-693 / 22 | 120-135 / 36-44 |
| 256 indexed | 6,553 | 1,410-1,460 / 725-746 / 24-25 | 110-115 / 35-39 |
| 256 foreground and background | 6,566 | 1,340-1,360 / 710-714 / 23-24 | 125 / 35-43 |
| 256 24-bit on background | 6,557 | 1,330 / 697-698 / 23-24 | 115-140 / 39-41 |
| 256 attribute combinations | 6,103 | 1,310-1,360 / 647-678 / 18 | 155-180 / 45-57 |
| 2,048 24-bit | 33,838 | 5,770-5,920 / 3,140-3,247 / 140-144 | 130-145 / 32-33 |
| 2,048 foreground and background | 33,767 | 6,110-6,130 / 3,421-3,452 / 155-159 | 145 / 33-34 |
| **W3, 0.5 MiB** | 17,369 | **2,940-3,050** / 1,642-1,694 / 78-80 | 180-195 / 56-57 |
| **W3, 1 MiB** | 28,513 | **6,980** / 3,691-3,723 / 167-169 | 170-175 / 38 |
| **W3, 2 MiB** | 45,272 | **13,070-13,120** / 6,690-6,792 / 284-287 | 365-385 / 68-69 |
| **W3, 4 MiB** | 70,906 | **23,190-23,200** / 11,606-11,674 / 450-455 | 575-620 / 126-131 |

**Paced (one frame per 16 KiB chunk, 66 renders per pass; 130 for W3 2 MiB), phone viewport, cold pass against the median of the two warm ones**

| Stream | WebGL: CPU ms (cold / warm), wall ms (cold), dropped frames (cold) | DOM: CPU ms (cold / warm), dropped frames |
|---|---|---|
| 1 style | 370-380 / 180-195, 1,083, 0 | 390-400 / 310-340, 0 |
| 256 24-bit | 1,660-1,680 / 215-235, 1,466, 23 | 680-730 / 560-590, 0 |
| 2,048 24-bit | 6,710-7,010 / 280-285, 3,632-3,721, 152-158 | 690-730 / 595-635, 0 |
| W3, 1 MiB | 7,920-8,090 / 325-345, 4,237-4,276, 188-191 | 950 / 795-975, 0 |
| W3, 2 MiB | 13,910-14,370 / 695-745, 7,234-7,398, 305-314 | 1,640-1,650 / 1,455-1,480, 0 |

Reading it, for this host and renderers:

- **The WebGL addon's first-appearance cost is real, large, and tied to the number of distinct visible cells, not to bytes.** With one style family at a time the cold pass costs 1.3 to 1.5 s of CPU for 6,100 to 6,600 cells and 5.8 to 6.1 s for about 33,800, while the warm passes over the same bytes cost 0.11 to 0.18 s and 0.13 to 0.15 s. In the paced rows, where every pass renders the same 66 frames, that is 0.19 to 0.22 ms of CPU per cell in excess of the warm pass at the phone grid (0.12 to 0.17 ms at the desktop grid), with a larger per-cell figure for the 26 to 832 cell streams where a per-frame fixed part dominates. The five families cost the same at the same cell count (6,103 to 6,566 cells: 1.31 to 1.46 s), so no family is the expensive one. The DOM renderer has no such effect: in the paced rows its cold pass is within 30 % of its warm one (3 % below to 29 % above) and drops no frame at the phone grid.
- **A first appearance is work in the frame that shows it, so it appears as dropped frames when output arrives fast.** In the paced rows, 6,558 cells cost 23 dropped frames and 33,838 cost 152 to 158 (at the nominal 16.7 ms). Streams with 208 to 1,664 cells cost 0 to 6 dropped frames and 80 to 230 ms of wall time in the cold pass.
- **W3's cost is mostly its cell count.** The 593 SGR sequences of W3 produce many more cells than sequences because attributes accumulate until a reset: 17,369 distinct visible cells in its first 0.5 MiB, 28,513 in 1 MiB, 45,272 in 2 MiB and 70,906 in 4 MiB at the phone grid (46,141 to 176,469 at the desktop grid), which is why its cold pass keeps growing with size (3.0 s of CPU at 0.5 MiB, 7.0 at 1, 13.1 at 2, 23.2 at 4) while the warm pass over the same bytes costs 0.17 to 0.62 s. In the paced rows that is 0.27 to 0.30 ms per cell at the phone grid (0.21 to 0.25 at the desktop grid), 1.2 to 1.6 times the single-family rate (1.2 to 2.1 times at the desktop grid); that remaining excess was not isolated (more kinds of attribute per cell and cost that grows with the size of the glyph cache are candidates; neither was tested). The paced W3 pass shows the render count is not the cause: the same 66 renders cost 7.9 to 8.1 s of CPU cold and 0.33 to 0.35 s warm.
- **The stall is a cost of the first time, per page, not of the workload.** A terminal that rarely shows more than a few hundred distinct styled glyphs would pay tens to a few hundred milliseconds once. The harness's median of five runs hid it, and it is consistent with the run-to-run spread of the desktop W3 figures in the shootout (2.5 to 28 MiB/s across the five runs of a page). Whether other events that empty the glyph cache (a theme or font-size change) bring it back was not measured; the context restore of the next section redraws a screen of a few hundred distinct cells and took about 100 ms, which is the cost of taking the screenshot.

**Desktop viewport (152 by 38 cells at devicePixelRatio 1)** the same experiment gives lower per-cell costs for the single-family streams (46,288 24-bit cells: 1.99 to 2.00 s cold against 0.48 to 0.52 s warm, 48 to 51 dropped frames; 6,654 cells: 0.72 to 0.75 s against 0.19 to 0.21 s) but the same shape, and a worse W3 (it produces many more distinct cells on 152 columns): paced, 1 MiB cost 15.9 to 16.7 s of CPU and 9.8 to 10.0 s of wall time with 529 to 540 dropped frames in the cold pass against 0.87 to 1.03 s warm, and 2 MiB 29.2 to 30.7 s and 18.0 to 18.4 s with 957 to 980 dropped frames. The DOM renderer paced W3 cost 2.8 to 2.9 s (1 MiB) cold and 2.1 to 2.2 s warm with 9 to 13 dropped frames. Unpaced desktop rows are confounded by the render count (the DOM renderer rendered once in many warm passes) and are in the raw files only.

What the experiment does not show: why the addon's cost per cell is what it is (its texture atlas, glyph drawing and page merging were not profiled), whether another `devicePixelRatio`, font size or the atlas options of the addon change it, whether a mitigation (drawing the common glyphs ahead of the first output, limiting style variety, a bigger or preallocated atlas) removes it, an Android WebView, and any real terminal session (the streams are synthetic and uniformly random in style; real output reuses a small set of styles and the cell counts here are an upper range for it).

#### WebGL context loss and recovery ([#1323](https://github.com/mihazs/lazysh/issues/1323))

`e2e/terminal-webgl-context-loss.spec.ts` (run by `bun run bench:terminal terminal-webgl-context-loss`, and skipped where the browser has no WebGL2 so it also runs in the normal Playwright suite) takes the WebGL context away from the benchmark page's terminal with `WEBGL_lose_context` and gives it back. Correctness is pixels: a screenshot of the terminal against one from a terminal that never lost its context and was fed the same bytes (60 rows of ANSI colour, bold, 256-colour backgrounds, accents, CJK and an emoji). `@xterm/addon-webgl` 0.18.0 waits 3000 ms for the browser to restore a lost context and only then fires `onContextLoss`, which is what the benchmark page uses to dispose the addon and leave the DOM renderer; the benchmark page, not the app, has that handler (the app does not load the addon). Three invocations on the committed tree: hardware GL twice and SwiftShader (software GL) once; every scenario passed in all three. Raw files: `benchmarks/terminal-context-loss-xterm-webgl-hw-desktop.json`, `-hw-repeat-desktop.json` and `-sw-desktop.json`.

| Scenario | Result (hardware GL, two invocations; software GL in brackets where it differs) |
|---|---|
| Method check: pixels while the context is lost | Different from the never-lost terminal in every scenario, so "identical after restore" is not vacuous. |
| Restored 0.3 s and 2.0 s after the loss (inside the grace period) | The addon recovers on its own and the app is never asked to fall back (`onContextLoss` fired 0 times). The first screenshot taken after the restore was already identical to the never-lost terminal; taking it cost 102 to 120 ms (173 to 194 ms in software), so that is an upper bound on recovery. The canvas `webglcontextlost` event arrived 2.3 to 4.6 ms after the loss (6.1 to 6.9 in software) and `webglcontextrestored` 5.9 to 9.0 ms after the restore (5.7 to 6.3). |
| 684 bytes of output written while the context was lost, then restored | Pixel-identical to a never-lost terminal that received the same bytes, 120 to 121 ms upper bound (185 in software). |
| Never restored | `onContextLoss` fired 3002 to 3005 ms after the loss. Disposing the addon there left the DOM renderer (0 canvases) with pixels identical to a DOM terminal fed the same bytes and the buffer intact, including the output written while the context was lost. A restore arriving after the fallback changed nothing on screen. Loading a new addon then drew pixels identical to a never-lost WebGL terminal with 2 canvases again, 126 to 142 ms upper bound (213 in software). |
| Page errors | None in any scenario (asserted). |

Observed mutation check: if the benchmark page's handler does not dispose the addon on `onContextLoss`, the never-restored scenario fails (2 canvases left instead of 0).

What this shows is that the addon's public surface (`onContextLoss`, `dispose`, loading a new addon) is enough for an application to fall back to the DOM renderer and return to WebGL without losing the buffer or changing pixels, and that the browser's restore path repairs the terminal itself. It does not show that the app does this: the app has no such handler, and writing it is part of adopting the addon. Not covered, and the reason the Android gate in [the procedure below](#android-procedure-manual-gate-not-run) stays open: an Android WebView (the loss there comes from the GPU process being killed, memory pressure or the app being backgrounded, not from a script calling `loseContext`), a crash and restart of the GPU process (every context of the page is lost at once), many terminals losing contexts together (browsers cap the number of live WebGL contexts per page; ten mounted terminals ran in W9 but more were not tried), background and resume (W11), and the cost of re-uploading the glyph atlas on a phone GPU. The recorded times are screenshot-bound upper bounds taken on a shared host.

#### The same runs in the Android System WebView on Waydroid ([#1323](https://github.com/mihazs/lazysh/issues/1323))

The first-burst and context-loss specs run unchanged inside a real Android System WebView when `LAZYSH_BENCH_ANDROID=<adb serial>` is set: the page fixture starts a fresh process of a throwaway host app (`apps/client/bench/android-webview`, a full-window `WebView`, built by `bench/android-apk.sh` from the SDK command-line tools, not part of the app or CI), forwards its remote-debugging socket to Playwright with `connectOverCDP`, and reaches the benchmark server through `adb reverse`. Device: the Waydroid guest of the Canvas replay (Android 13 x86_64, `com.android.webview` 153.0.8010.36, Chromium 153; display override 1080 by 2400 at 420 dpi, so the page is 411 by 782 CSS px at devicePixelRatio 2.625, 48 by 34 cells (33 rows in one context-loss invocation: another user of the guest changed the display override in between); its refresh interval calibrates to 4.2 ms, so "dropped frames" here count against 4.2 ms and are not comparable with the 16.7 ms rows above: use wall time and the frame interval p99). WebGL 2 is hardware: `AMD Radeon Graphics (radeonsi, navi14, ACO)` through Mesa's GLES, `OpenGL ES 3.0 Chromium`, which is the host's discrete GPU behind the guest, not a phone GPU. A WebView has no process list, so per-process CPU is `null` (not zero) and heap and resident memory were not measured.

*Context loss*, four scenarios, two invocations on a clean tree (`2e89b89d`, `dirty` false; the specs reject a row if the host app has lost the window focus): every scenario passed in both and ended pixel-identical, as on the desktop runs. Restored after 0.3 s and 2.0 s the addon recovered itself (the screenshot after the restore was identical at the first poll, 238 to 428 ms, a screenshot-bound upper bound that is two to four times the desktop figure, probably because the CDP screenshot of a WebView is slower (not tested)); 684 bytes written while lost appeared after the restore (363 and 404 ms); never restored, `onContextLoss` fired at 3,003 and 3,015 ms, the DOM renderer drew the pixels of a DOM terminal with the buffer intact (380 and 414 ms), a late restore changed nothing and a new addon drew the pixels of a never-lost WebGL terminal (349 and 267 ms). Raw files `benchmarks/terminal-context-loss-xterm-webgl-android-webview-waydroid.json` and `-repeat.json`.

*First-burst stall*, WebGL addon and DOM renderer, one complete invocation (16 of 16 rows, every pass on the expected screen) and 13 rows of a second that failed at row 14 (`-incomplete.json`; its rows agree with the first, see below). Runs before the focus guard existed, with a host app that could be relaunched by a resize of the shared guest; the guest is shared and another agent's mobile end-to-end runs were using it at the same time; the later attempts hung or closed the page with the window focus on another app, and those files are not used (the cause was inferred from the focus and the logcat of one of them, which showed the activity being relaunched, and was not proved for each). Cold pass against warm passes over the same bytes, wall time in ms (the two warm passes) and the cold pass's frame interval p99 and long tasks:

| Stream | DOM renderer, 66 renders | WebGL addon, cold pass | WebGL addon, warm passes |
|---|---|---|---|
| 1 style, paced (one frame per chunk) | 270 to 275 | 275 (p99 5.7 ms, 0 long tasks) | 270 |
| 256 24-bit styles (6,551 cells), paced | 498 to 526 | 854 (p99 99 ms, 4 long tasks) | 270 to 271 |
| 2,048 24-bit styles (33,303 cells), paced | 506 to 608 | 3,310 (p99 156 ms, 22 long tasks) | 270 |
| W3 1 MiB (28,454 cells), paced | 471 to 636 | 3,963 (p99 127 ms, 46 long tasks) | 270 to 271 |
| 256 24-bit styles, unpaced | 447 to 529 | 691 and 736 (p99 108 to 109 ms, 3 long tasks) | 45 to 62 |
| 2,048 24-bit styles, unpaced | 447 to 550 | 2,976 and 3,119 (p99 128 to 130 ms, 19 to 21 long tasks) | 39 to 56 |
| W3 1 MiB, unpaced | 444 to 536 | 3,913 and 4,167 (p99 124 to 147 ms, 41 to 48 long tasks) | 53 to 72 |

- **The stall reproduces in the Android WebView, with the same shape and about the same size.** The paced cold excess over the warm pass is 0.58 s (256 styles), 3.04 s (2,048) and 3.69 s (W3, 1 MiB), which is 0.09, 0.09 and 0.13 ms of wall time per distinct cell; the same streams in desktop Chromium with the phone viewport (devicePixelRatio 3) cost 0.38, 2.55 and 3.19 s, 0.06, 0.08 and 0.11 ms per cell. The WebView is 1.2 to 1.5 times slower per cell than emulated Chromium on this host, and the frame intervals of the cold passes are 99 to 156 ms.
- **When the glyphs are cached the WebGL addon is the faster renderer in this WebView.** A warm paced pass takes 270 ms (66 frames of 4.1 ms, the guest's refresh interval), where the DOM renderer takes 471 to 636 ms for the same frames (about 7.5 ms per frame), and an unpaced warm pass takes 39 to 72 ms against 444 to 550 ms for the DOM renderer, which takes 33 to 98 ms for the same streams in desktop Chromium with the phone viewport. Why the DOM renderer is that much slower in the WebView was not isolated.
- **The no-new-styles case costs nothing extra.** With one style the cold and warm passes are equal to 5 ms for both renderers.

*Not covered*, and why the Android gate stays open: any phone (the GPU here is a desktop one behind the guest's GLES, with its own memory bandwidth and thermal limits; a phone driver may be slower, lose contexts differently or not expose WebGL 2), the WebView's real context-loss triggers (GPU process kill, memory pressure, the app being backgrounded and resumed: only the scripted loss ran), energy, JS heap and resident memory (no `Performance.getMetrics` process counters were collected), a release build of the app's own WebView (the benchmark page is loaded from a development host), and more than one complete invocation of the first-burst rows.

Not shown: anything about Android, an Android WebView (which is Chromium, but its GPU, driver, memory pressure and context-loss behaviour are exactly what is unknown), the Linux desktop WebView (WebKitGTK, not Chromium), macOS or iOS (WKWebView), Windows (WebView2), energy, thermal behaviour, context loss caused by the platform in an Android WebView (the scripted loss above, in desktop Chromium and in the Waydroid WebView, is the only one run), background and resume (W11), accessibility with a canvas renderer, a phone GPU (the phone viewport above is emulated on the desktop one, and the Waydroid WebView sits on the same desktop GPU), W5 to W8 and W13. WebGL numbers here come from a discrete desktop GPU shared with other work; they do not transfer to a phone GPU.

### Program workloads (W5 to W8 and W11)

Recorded sessions of real programs, replayed a step at a time through the two engines ([#1303](https://github.com/mihazs/lazysh/issues/1303)). The workload definitions are renderer-neutral: `apps/client/bench/programWorkloads.ts` builds them from the conformance captures in `packages/terminal-runtime/fixtures` (their bytes, chunked as the Rust session workers chunk a pty, and the screen xterm.js 5.5.0 shows after them, which the core also shows: its divergences from xterm.js are terminal replies), from the captured Mosh display updates of `apps/client/e2e/fixtures/mosh-resize-frames.json`, and from a seeded agent stream (`agentStream` in `bench/workloads.ts`). Each workload carries its source, geometry, steps, the screen and cursor it must end on (after every step, for Mosh), its byte count and the SHA-256 of its bytes. A run that ends on any other screen fails.

```sh
cd apps/client
bun run bench:terminal -- e2e/terminal-programs.spec.ts --project=desktop   # xterm.js in Chromium, about 2 minutes; LAZYSH_BENCH_OUT=<file> names the result
bun bench/programWorkloads.ts /tmp/programs.json                            # the same workloads as JSON, for the core
cd ../../packages/terminal-runtime                                          # built as in its README
cargo run --release --example program_workloads -- /tmp/programs.json 100   # the core, 100 fresh sessions per workload
```

The spec also runs in smoke mode inside the normal Playwright suite (two repetitions per workload, correctness only, no timing thresholds), and `bench/programWorkloads.test.ts` replays every stream workload through xterm.js headless (three times for a repeatable one) and checks its screen, rebuilds each captured Mosh update from its body and envelope, and checks the agent stream generator against xterm.js at several geometries (the canonical Mosh resize needs xterm.js's internals in a mounted terminal, so the page run and the core's example are what replay those). With `LAZYSH_BENCH_ANDROID` the spec drives the Android System WebView of that device, as the first-burst spec does; the [Waydroid lane runbook](waydroid-lane.md#the-program-workloads-on-the-lane) has the command. The core's example is a host binary: nothing runs it inside a guest.

| Id | Workload | Source | Geometry | Steps | Bytes | What a step is |
| --- | --- | --- | --- | --- | --- | --- |
| W5 | vim 9 on a three-line file: insert, `:set number`, `gg`, `:q!` | `captures.json#capture-vim-edit` | 60x12 | 1 | 1600 | the whole recorded stream |
| W6 | tmux 3: two splits and a coloured `printf` | `capture-tmux-splits` | 60x14 | 1 | 2100 | the whole recorded stream |
| W6 | Zellij 0.46: a command, a new pane and a command in it | `capture-zellij-panes` | 100x16 | 2 | 18537 | a 16 KiB chunk |
| W7 | Mosh resize: six captured display updates, five of which change the size | `mosh-resize-frames.json` | 40x12 at the start | 6 | 1966 | one update's body, inside its begin and end envelope (which names the size) |
| W7 | Mosh reconnect: the first captured update on a fresh session | the same, first frame | 40x12 | 1 | 364 | as above |
| W8 | Claude Code 2.1 first run: theme picker to login method | `capture-claude-onboarding` | 100x30 | 1 | 8291 | the whole recorded stream |
| W8 | Codex 0.167 first run: sign-in menu | `capture-codex-login` | 100x30 | 1 | 1995 | the whole recorded stream |
| W8 | OpenCode 2.2 home screen, text typed and cleared | `capture-opencode-home` | 100x30 | 1 | 14553 | the whole recorded stream |
| W8 | Agent streaming, seeded: one to three words per write, a five-row live region (answer line, spinner, prompt box) erased and redrawn after each | `agentStream(300 tokens, seed 80)` | 100x30 | 300 | 272397 | one write |
| W11 | Herdr 0.9 session redrawn 40 times while hidden, then resumed and its surface recreated | `capture-herdr-session` | 100x30 | 4 | 52508 (2.0 MiB delivered) | a 16 KiB chunk |

#### What is simulated and what is real

| Stage | Real | Simulated or missing |
| --- | --- | --- |
| Bytes | Real program output (vim, tmux, Zellij, Herdr, Claude Code, Codex, OpenCode) and real Mosh frames, replayed as recorded; the agent stream is generated | No transport: no remote, no timing between writes, no bridge (the JSON `number[]` decode of the baseline is not exercised). A capture's write boundaries are the harness's 16 KiB chunking, not the program's own |
| xterm.js | The app's `createTerminal()` and `XtermTerminalAdapter` (and, for Mosh, `enableCanonicalResize()`, as `App.tsx` does) on the DOM renderer, resized to the recorded geometry; a fresh session per repetition | Not the `TerminalPane`: it fits to its container and would undo the geometry (a phone viewport cannot hold 100 columns), so there is no toolbar, input layer or React tree. Session creation is not timed. The phone project (390 by 844 at 3x, run once, raw file not kept) gave the same p50 of every workload within 0.2 ms: the sessions do not depend on the viewport |
| The core | `TerminalRuntime` (with `canonical_frames` for Mosh), a fresh one per repetition, the bytes offered and pumped as the transport does | No renderer: a "frame" is the dirty-row frame a renderer would draw, not a draw. No bridge or surface |
| Resume and surface | W11: the pane hidden with `display:none` while 40 deliveries are applied, then shown; then `detach` and `attach` of the adapter. Core: the same output with no frame taken, then `take_frame()` (rows changed), then `snapshot()` (every row, for a new surface) | A native surface lost and recreated by Android is not exercised on either engine. For the DOM renderer a detached and re-attached terminal keeps its rows, so nothing is redrawn (`recreatedWithRender` is 0 of 100): that is the baseline's cost of a "recreated surface", not a statement about the native one |

#### Measured on the development host

Same host and toolchain as the tables above: AMD Ryzen 9 5900X, Linux 7.3.3, node 26.6.0 and Bun 1.3.14, headless Chromium 156.0.8078.4, xterm.js 5.5.0 DOM renderer, release (minified) page, rustc 1.96.1 release for the core, the xterm.js run at commit `02c6e90d` and the core at `ec4ad0f5` (two unrelated commits apart: a docs rule and an iOS test), both with these changes uncommitted (`dirty: true`). The 1-minute load average was 3.3 at the end of the xterm.js run and 5.68 at the start of the core's: the host is shared, and an invocation of the core at another load gave the same order of every figure. Raw results: [`terminal-programs-xterm-dom-desktop.json`](benchmarks/terminal-programs-xterm-dom-desktop.json) (xterm.js; schema 1, with the fixtures' SHA-256 and the CDP counters per workload) and [`terminal-programs-core-host.txt`](benchmarks/terminal-programs-core-host.txt) (the core's output). Every repetition of every workload ended on the recorded screen, on both engines (the core panics otherwise; checked by corrupting a check in the workload file). Timestamps in the page have 0.1 ms resolution, so values near 0.1 ms are coarse. p50 / p95 / p99 in milliseconds.

xterm.js, 100 fresh sessions per workload (5 for the 300-step agent stream, which gives 1500 step samples):

| Workload | Variant | Geometry | Steps | Bytes | Write to applied | Write to the render that shows it | Session wall (p50) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W5 vim | insert, `:set number`, `gg`, `:q!` | 60x12 | 1 | 1600 | 0.5 / 0.9 / 1.3 | 16.7 / 16.9 / 17.0 | 16.7 |
| W6 tmux | two splits | 60x14 | 1 | 2100 | 0.6 / 1.0 / 1.8 | 18.1 / 18.9 / 19.8 | 18.1 |
| W6 Zellij | a new pane | 100x16 | 2 | 18537 | 1.0 / 1.5 / 2.3 | 17.7 / 19.7 / 21.0 | 34.7 |
| W7 Mosh resize | six updates | 40x12 | 6 | 1966 | 0.7 / 1.3 / 1.6 | 16.6 / 17.9 / 18.3 | 100.1 |
| W7 Mosh reconnect | first update | 40x12 | 1 | 364 | 0.3 / 0.5 / 0.7 | 17.9 / 18.8 / 21.2 | 17.9 |
| W8 Claude Code | first run | 100x30 | 1 | 8291 | 0.3 / 0.7 / 1.2 | 20.1 / 21.3 / 27.8 | 20.1 |
| W8 Codex | sign-in menu | 100x30 | 1 | 1995 | 0.3 / 0.7 / 1.1 | 18.3 / 19.5 / 20.2 | 18.4 |
| W8 OpenCode | home screen | 100x30 | 1 | 14553 | 1.2 / 2.0 / 3.1 | 19.4 / 21.0 / 22.3 | 19.5 |
| W8 agent streaming | 300 writes | 100x30 | 300 | 272397 | 0.5 / 0.9 / 1.2 | 16.7 / 16.9 / 17.2 | 5000.1 |

Each step is written, then waited on until xterm renders it (at most 100 ms), so a session's wall time is its steps times a frame; no frame was dropped and no long task ran in any of them. The render column is the frame clock (16.7 ms at 60 Hz) plus the work, and the heavier screens (Claude Code, OpenCode) sit a few milliseconds above the rest; which part of xterm accounts for it was not isolated.

The core, 100 fresh sessions per workload, from `program_workloads`:

| Workload | Variant | Geometry | Steps | Bytes | Parse a step | Parse and take the frame | The same stream delivered back to back |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W5 vim | insert, `:set number`, `gg`, `:q!` | 60x12 | 1 | 1600 | 0.030 / 0.053 / 0.059 | 0.069 / 0.107 / 0.124 | 156.2 MiB/s (1311 deliveries) |
| W6 tmux | two splits | 60x14 | 1 | 2100 | 0.033 / 0.039 / 0.047 | 0.088 / 0.098 / 0.111 | 107.1 MiB/s (999 deliveries) |
| W6 Zellij | a new pane | 100x16 | 2 | 18537 | 0.097 / 0.119 / 0.138 | 0.236 / 0.280 / 0.331 | 196.2 MiB/s (114 deliveries) |
| W7 Mosh resize | six updates | 40x12 | 6 | 1966 | 0.005 / 0.016 / 0.018 | 0.038 / 0.052 / 0.057 | not repeatable |
| W7 Mosh reconnect | first update | 40x12 | 1 | 364 | 0.008 / 0.014 / 0.017 | 0.044 / 0.050 / 0.061 | not repeatable |
| W8 Claude Code | first run | 100x30 | 1 | 8291 | 0.078 / 0.101 / 0.117 | 0.270 / 0.356 / 0.395 | 148.2 MiB/s (253 deliveries) |
| W8 Codex | sign-in menu | 100x30 | 1 | 1995 | 0.029 / 0.036 / 0.041 | 0.203 / 0.217 / 0.232 | 163.4 MiB/s (1052 deliveries) |
| W8 OpenCode | home screen | 100x30 | 1 | 14553 | 0.084 / 0.095 / 0.102 | 0.363 / 0.381 / 0.396 | 221.0 MiB/s (145 deliveries) |
| W8 agent streaming | 300 writes | 100x30 | 300 | 272397 | 0.003 / 0.006 / 0.010 | 0.052 / 0.122 / 0.269 | not repeatable |

The two tables measure different things and **no ratio between them is valid**: xterm.js's number is a page-clock interval from `write` to its write callback or to the next render, which includes the turn xterm schedules a write on and is bounded by a 0.1 ms clock and a 60 Hz frame; the core's is the parse, and the parse plus the dirty-row frame, on a nanosecond clock with no scheduling, no renderer and no frame clock. What they do say together: the same recorded bytes end on the same screens on both engines, including the five Mosh canonical resizes and the multiplexer and agent redraws, and the core's share of one step is a fraction of a millisecond on every workload here. Neither says what a phone costs.

W11, 100 fresh sessions per engine, 40 deliveries (2.0 MiB) of the Herdr session while nothing is drawn, then resume, then a recreated surface:

| Engine | Output applied while hidden | Resume | Recreated surface | Screen after each |
| --- | --- | --- | --- | --- |
| xterm.js, pane `display:none` | 32.7 / 38.1 / 41.0 ms for the 2.0 MiB (59 MiB/s over the run, with one macrotask yield per chunk) | 19.2 / 34.4 / 35.7 ms from showing the pane to the next render (a render followed in 100 of 100 sessions) | 16.7 / 16.8 / 16.9 ms from `attach` to the next frame; xterm did not redraw (0 of 100) | the recorded one, 100 of 100 |
| The core, no frame taken | 111.0 MiB/s median (94.4 to 113.5) | `take_frame()` 0.345 / 0.405 / 0.485 ms | `snapshot()` 0.295 / 0.329 / 0.360 ms | the recorded one, 100 of 100 |

State was preserved in every run: the hidden terminal parsed everything and showed the recorded screen on resume. The xterm.js resume time (19 ms at the median, a frame plus the repaint of the shown pane) is consistent with xterm parsing the output while the pane is hidden and drawing when it is shown; the split between the two was not isolated. The core's resume and recreate times are the cost of producing a frame, not of drawing it.

#### What this does not show

- **No Android number.** `waydroid session start` fails on the maintainer's machine (the container's network script needs root), so neither engine was run on the Waydroid lane; the spec is written to run in the guest's WebView and the command is in the [runbook](waydroid-lane.md#the-program-workloads-on-the-lane), but it has not been run there. No gate row moves. The core has no Android run of this example at all.
- **Short recorded sessions.** The captures are scripted first-run and a few keystrokes, 0.4 to 52 KiB: they test a real program's escape sequences, not a long editing or multiplexer session, and the W5 vim session is 1.6 KiB. Neovim was not recorded (`nvim` is not installed here). The W8 captures stop at login screens: a signed-in Claude Code, Codex or OpenCode turn needs an account and a network, and a capture would hold a prompt and a reply. The streaming half of W8 is a seeded generator shaped like their live-region redraws, not a capture.
- **No timing between writes and no remote.** Steps are delivered back to back (xterm.js: one per frame), not at the pace the program produced them, and there is no input: keystrokes are W12.
- **No energy, no thermal behaviour (W13), no phone GPU, no native surface.**

### Android procedure (manual gate, not run)

The harness drives the benchmark page over CDP; on the Waydroid lane it does so in the guest's Android System WebView, and [the same-run comparison below](#same-run-comparison-on-the-waydroid-lane-g14-g15-g16-idle) reads the guest's own counters beside it. For a **physical device**, which the lane does not replace for energy, thermal behaviour and a phone GPU ([#1303](https://github.com/mihazs/lazysh/issues/1303), [#1340](https://github.com/mihazs/lazysh/issues/1340)), the measurement is still a manual gate with this procedure. **None of it has been executed;** the tools named are standard Android tooling and the steps have not been validated on a device for this app.

1. Fix the conditions and record them in the environment block: physical device (model, SoC, RAM, Android build, WebView version from `adb shell dumpsys webviewupdate`), release build of the app (`app.lazysh.client`), fixed brightness, airplane mode with Wi-Fi only (or a fixed radio), battery above 80 %, thermal state cool, screen kept awake, the same SSH host and the same replay fixture for each run.
2. Reset counters: `adb shell dumpsys batterystats --reset`, `adb shell dumpsys gfxinfo app.lazysh.client reset`.
3. Run one workload (for example `cat` of the W2 fixture on the host over SSH, then W0 idle for 5 minutes) while recording a Perfetto trace from the Perfetto UI "Record new trace" page with the scheduling, CPU frequency and idle, GPU, frame timeline, input and `webview` categories enabled; keep each trace short enough to open.
4. Collect: `adb shell dumpsys gfxinfo app.lazysh.client framestats` (frame pacing and janky frames), `adb shell dumpsys meminfo app.lazysh.client` (peak and steady memory, per-session by opening N sessions), `adb shell dumpsys batterystats app.lazysh.client` plus a bug report for energy attribution, and `adb shell dumpsys cpuinfo` for CPU share. A debuggable build and Chrome DevTools remote debugging (`chrome://inspect`) can add `Performance.getMetrics`-style counters for diagnosis but must not be used for the final figures.
5. Input-to-presentation needs an external reference (a high-speed camera or a photodiode); without one, an in-app marker plus the frame timeline gives an estimate that must be labelled as such.
6. Repeat at least five times per workload, keep the raw traces beside the JSON, and fill the schema above with `null` for anything the device cannot provide.

### Same-run comparison on the Waydroid lane (G14, G15, G16 idle)

The Android runs above measure one engine at a time and read the page's own counters. Gates G14, G15 and the idle half of G16 ask a different question: is the native engine worse than xterm.js, **on the same workloads, in the same lane run, on the same guest** ([#2407](https://github.com/mihazs/lazysh/issues/2407), part of [#2093](https://github.com/mihazs/lazysh/issues/2093)). This section is the harness for it and the rules it decides by. The rules were fixed, and committed with this section, before any native number existed: if native loses, Android keeps xterm.js ([migration plan](terminal-migration-plan.md#acceptance-gates-and-evidence)) and nothing here is retuned.

**Run it** ([lane runbook](waydroid-lane.md#the-engine-comparison-on-the-lane)): `androidEngineBench.ts` runs the baseline spec (W0 to W4, W9, W12) for each xterm.js renderer asked for in the guest's Android System WebView (`bench/android-webview` host app) and writes one record; the native engine's driver writes the same record, with the adapter `native-wgpu`, into the same run; `androidCompare.ts <record>...` decides the targets and exits 0 (all met), 1 (a target not met: native loses), 2 (unusable input: a record that is not one, different runs or different guests) or 3 (incomplete: no native arm, or a target nothing was measured for).

**The record** (`schema` 1, `kind` `android-engine-comparison`): the run id and start and end times, the commit, an `environment` block (device and guest, Android version, display refresh rate, GPU path with the raw EGL and GLES strings, WebView version, host app), `limits` and `acceptedRisk` (energy, real GPU drivers, thermal, arm64, vendor WebView and ROM: always "accepted risk, not measured"), one entry per `arms` (adapter name, engine, host app, GPU the engine drew on, page geometry, how the engine was measured) and the `measurements`: one per adapter, workload, variant and metric with the number of runs, the number of samples, p50, p95, min and max over the runs and the per-run values. For a metric sampled many times in every run (latency) p50 and p95 are the medians of each run's own p50 and p95; for a metric with one value per run, p50 is the median of the runs and p95 their 95th percentile (the largest, with five runs). A figure that was not measured is absent, never zero.

**Instruments.** The same for every engine, read from the guest and not from the engine: CPU time (`/proc/<pid>/stat`, 10 ms ticks) and thread wakeups (voluntary context switches of every thread, `/proc/<pid>/task/*/status`) of the app process and the WebView renderer processes it started (they are children of `webview_zygote` named after the WebView package; they are told from another app's by having started after the app process); frames presented and janky frames of the app's layers (`dumpsys SurfaceFlinger --timestats`, per layer, so the WebView window and a native `SurfaceView` are both counted; the legacy `--latency` returns zeros for these layers on this guest); and PSS (`dumpsys meminfo <pid>`, summed over those processes). Each measured window is read between two adb calls of 10 to 40 ms, so a window shorter than a second carries that much of the time around it: frame counters are reported only for sustained output (the W12 flood and W9), where the window is seconds long. Latency is the engine's own render event, an estimate in the sense of the [stage table](#stage-separation); the remote echoes at once.

**The native arm** is not built yet: it needs the first native session through the real UI ([#2093](https://github.com/mihazs/lazysh/issues/2093)) and the pane-to-grid path. What it must produce, so that the comparison is valid: a record with the same run id and guest, the adapter `native-wgpu`, the wgpu adapter and backend in `arms[].gpu`, the same workload and variant ids and the same metric ids, folded with `perRun` and `perRunSummaries` from `androidEvidence.ts` (so p50 and p95 mean the same thing); the workloads' bytes from `bench/workloads.ts` (same seeds, sizes and 16 KiB chunks) and the same end-screen checks, with `correct` false when the screen differs; the instruments above read from the guest, not from the engine's own counters (`GpuStats` may explain a result, it decides nothing). A latency is the key or burst to the frame the renderer submitted for it. It runs in the real app, so its total PSS includes the app's own page: the compare script then compares growth over one session, unless the xterm.js arm also ran in the real app (the engine chosen in Settings), in which case the arms name the same host and the totals are compared too.

**Metrics** (every arm reports these; `gate` is what a metric decides, none for informational):

| Metric | Unit | Better | Gate | Workloads | Definition |
| --- | --- | --- | --- | --- | --- |
| `throughputMiBs` | MiB/s | higher | G14 | W2, W3, W4 | bytes delivered until the end screen is shown |
| `cpuMsPerMiB` | ms CPU per MiB | lower | G14, key | W2, W3, W4 | CPU of the app and its renderer processes per MiB delivered |
| `inputLatencyMs` | ms | lower | G14, key | W12 (idle keys, auto-repeat, during output, IME), W9 with 5 and 10 sessions | key or commit to the frame that shows its echo |
| `outputLatencyMs` | ms | lower | G14, key | W1 | burst written to the frame that shows it |
| `jankyFramePercent` | % | lower | G14 | W12 during output, W9 | share of the app's timeline frames that missed their deadline |
| `frameIntervalMs` | ms | lower | none | same | interval between presented frames; an engine that coalesces redraws presents less often without being slower, so it is read beside the jank rate and decides nothing |
| `idleCpuMsPerSecond`, `idleWakeupsPerSecond`, `idleFramesPerSecond` | per second | lower | G16 | W0, cursor blink on and off | CPU, thread wakeups and presented frames at idle (30 s windows, 3 runs) |
| `pssMiB` | MiB | lower | G15 | W9 with 5 and 10 sessions | total PSS; compared only when both engines ran in the same host app |
| `pssGrowthMiB` | MiB | lower | G15 | W9 with 5 and 10 sessions | PSS with N sessions minus PSS with one session |
| `pssChurnDriftMiB` | MiB | lower | G15 | W9 churn | PSS after the last of five open-five-sessions-then-close cycles minus after the first |

**The rules** (`apps/client/bench/androidCompare.ts`, `RULES`). A difference between native and an xterm.js arm is noise when it is smaller than 10 % or than the run-to-run spread of either number, whichever is larger; beyond that it is a win or a regression. Each target is judged against every xterm.js arm in the run, and is met only if it is met against all of them.

| Target (PRD) | Met when |
| --- | --- |
| No correctness regression | every workload of every arm ends on its expected screen |
| No input-latency regression under heavy output | no p50 or p95 of `inputLatencyMs` is worse while W2 floods the terminal and with 5 and 10 sessions streaming |
| No material regression elsewhere | no G14 figure (throughput, CPU per MiB, latency, jank) is worse |
| At least 25 % on one key latency or CPU metric | some key figure is better by 25 % or more and beyond the noise |
| Near-zero idle activity | idle CPU, wakeups and frames are at or below a floor of 10 ms/s, 20 /s and 3 /s (a blinking cursor is about 2 frames a second), or not worse than xterm.js |
| Memory not worse across 5 and 10 sessions and churn | no G15 figure is worse |

Not decided here, because the lane cannot show it: battery energy (the 20 % target), thermal behaviour, a phone GPU, refresh pacing on a real display, vendor WebView and ROM. They stay "accepted risk, not measured" in every record.

#### Measured so far

**Nothing from the lane yet.** The harness was exercised end to end on the Waydroid guest on 2026-11-22: a smoke-scale run of the baseline spec in the guest's WebView read real CPU, wakeup, SurfaceFlinger and PSS counters for every workload, including the churn workload. Three full-scale runs were started and none finished: the first was spoiled when another lane uninstalled and launched the app under test while it held the window focus and, in the same minutes, a `waydroid app launch` of the host app by the runner itself reopened its page as `about:blank` (the page under test ended up in a background activity); the second was stopped by hand because its W9 stage, at 200 keys a run, would have taken over an hour (below); the third was cut off by a desktop reset under load, after which the Waydroid session did not come back without root. No figure from any of them is recorded, so the xterm.js side of G14, G15 and the idle half of G16 is **not measured**, and no number may be quoted here until a complete run's record is committed under `benchmarks/` with its run id.

What the abandoned runs did show, and the next run is arranged around: with five background sessions streaming at full rate, the WebView's main thread is so busy that a key typed through the DevTools protocol took about 1.8 s to reach the page (about 0.55 keys/s), against about 20 ms in desktop Chromium, so the Android run types 40 keys per W9 run instead of 200 (`sessionKeys` in `e2e/terminal-bench.spec.ts`); the rest of the full-scale run (W0 to W4, W10, W12) took about 8 minutes. The guest's display runs at 240 Hz, so a focused xterm.js terminal with the cursor blinking presents frames at close to the display rate (31 frames in 0.32 s in the smoke run).

## Results

| Workload | xterm DOM (desktop Chromium) | xterm optimized: WebGL addon, hardware GL | xterm canvas addon; WebGL software GL | Native candidate(s) | Winner (per device) |
| --- | --- | --- | --- | --- | --- |
| W0, W1, W2, W3, W4, W9, W10, W12 | measured, [baseline](#measured-baseline) | measured, [shootout](#renderer-shootout-xtermjs-renderers-1323): on par or better except W3 frame pacing, W4 CPU and fixed memory | measured: much slower | host and Waydroid microbenchmarks only: [parse stage on these very workloads](#parse-stage-on-the-baselines-own-workloads-native-core-versus-xtermjs-host-microbenchmark-not-a-device-baseline), [wgpu prototype](#wgpu-prototype-against-the-cpu-reference-renderer-host-gpu-not-a-device), [Android Canvas replay](#android-canvas-drawing-of-the-shared-layout-waydroid-not-a-device), [WebAssembly parse](#webassembly-vt-versus-xtermjs-parse-only-host-microbenchmark-not-a-candidate); no text, no device | undecided; see [ADR 0001, amendments 1 and 2](adr-0001-terminal-runtime.md#amendment-1-2026-11-12-first-renderer-shootout-results) |
| W5, W6, W7, W8, W11 | measured on desktop Chromium, [program workloads](#program-workloads-w5-to-w8-and-w11); not on Android (the Waydroid lane could not start) | not measured | not measured | the core on the same bytes and screens, host microbenchmark, same section; no renderer, no device | undecided |
| W13 | not implemented | not measured | not measured | not measured | undecided |
| All workloads on Android | not measured (the harness for the same-run comparison on the Waydroid lane exists, [no recorded run yet](#measured-so-far)) | not measured | not measured | not measured (the Canvas replay ran on Waydroid, which is not a device) | undecided |

### Core parse throughput (host microbenchmark, not a device baseline)

Measured with `cargo run --release --example parse_bench` in `packages/terminal-runtime` (each workload is 64 MiB fed in 16 KiB chunks as the transport sends them; five runs per invocation, the median is taken). It isolates the VT parse and state-update stages of the [stage separation](#stage-separation) for the Rust core only: no transport, no JS bridge, no renderer, no xterm.js comparison, and no device. It must not be read as evidence about Android or about xterm.js, and its generators are not the harness workloads W2 to W4, so no ratio against the xterm.js baseline above is valid.

Environment: AMD Ryzen 9 5900X (24 threads), Linux 7.3.1, rustc 1.96.1 release profile (the crate's pinned toolchain), libghostty-vt from the vendored Ghostty commit `44f2a44df` built with Zig 0.16.0 `ReleaseFast`, SIMD on, x86_64. The example prints the host load average at start.

The host was shared with other builds and agents. The section was first written from one invocation whose load was not recorded; nine more invocations were taken while the 1-minute load average at start was 13 and 18 (two invocations), 22 to 25 (four) and 61, 98 and 175 (three) on 24 threads. Their medians moved by up to a factor of two between invocations, so the table shows the lowest and highest median over the ten invocations instead of one number:

| Workload (80x24) | VT only, MiB/s | VT plus a dirty-row frame per 16 KiB chunk, MiB/s |
| --- | --- | --- |
| Plain text | 200 to 729 | 27 to 80 |
| ANSI and truecolor, many style changes | 40 to 75 | 25 to 46 |
| Full-screen redraw, 24 positioned rows | 216 to 403 | 38 to 70 |
| CJK, emoji, combining marks | 38 to 74 | 23 to 44 |

The high end is the closest figure to an uncontended machine; the low end is what a busy host produced. A quiet-host rerun with the load average recorded is still needed before any number here is used as a baseline.

Scrollback is budgeted in bytes by libghostty-vt, not lines. Rows kept after 8 MiB of output (the example prints this table; deterministic across invocations):

| Content | 256 KiB budget | 1 MiB | 4 MiB (the crate default) |
| --- | --- | --- | --- |
| Plain lines, 40 columns | 1,123 | 1,123 | 10,267 |
| Plain lines, 80 columns | 656 | 656 | 5,280 |
| Plain lines, 160 columns | 282 | 282 | 2,610 |
| CJK, emoji, combining, 80 columns | 984 | 984 | 5,030 |

Memory on the same host: ten sessions that each received 8 MiB of 80-column lines at the default budget held 39,268 KiB more resident memory than before they were created (about 3.8 MiB per session, dominated by the scrollback budget).

What this says, and does not say:

- The style-heavy and wide-character cases parse several times slower than plain text, so those workloads are the ones to compare first on devices.
- Copying every dirty cell into owned `String`-carrying structs costs far more than parsing; the current frame type is a correctness vehicle, not a renderer format, and [#1322](https://github.com/mihazs/lazysh/issues/1322) and [#1337](https://github.com/mihazs/lazysh/issues/1337) must replace it before any rendering number is meaningful.
- The byte budget does not map to lines. A 256 KiB and a 1 MiB budget kept the same number of rows, so the budget appears to be enforced in coarse steps below a few MiB, and for a fixed budget the rows kept fall with the column count (10,267, 5,280 and 2,610 at 40, 80 and 160 columns) and with content. The default 4 MiB budget keeps about lazysh's default 5000 lines at 80 columns and fewer than 3000 at 160, so the line setting of 100 to 20000 cannot be honoured by a fixed byte budget; [the mapping](#history-lines-to-scrollback-bytes-1319) derives the budget from the setting and the width instead.

### Parse stage on the baseline's own workloads: native core versus xterm.js (host microbenchmark, not a device baseline)

The earlier tables of the core use generators of their own, so no ratio against the recorded baseline was valid. This one feeds both engines the exact bytes of the baseline's streamed workloads: `bun bench/dumpWorkloads.ts <dir>` in `apps/client` writes W2 (plain, 4 MiB, seed 20), W3 (ANSI, 2 MiB, seed 30) and W4 (redraw, 1500 frames, seed 40) at the desktop (152x38) and phone (46x37) geometries with the sizes and seeds of `terminal-bench.spec.ts` (the byte counts equal the baseline's 4.00, 2.00, 9.22 and 3.37 MiB), together with the final screen the baseline expects. `node bench/harnessParse.mjs <dir>` runs xterm.js 5.5.0 headless (no renderer, scrollback 5000 lines) on them and `cargo run --release --example harness_parse -- <dir>` in `packages/terminal-runtime` runs the core (default 4 MiB scrollback). Both feed 16 KiB chunks, take five runs per invocation, and check that the final screen equals the baseline's expected screen (all twelve checks true in every invocation). Three invocations of each, taken one after the other at 1-minute load averages of 8.1 to 9.2 on 24 threads (printed at the start of four of the six invocations); the cells are the lowest and highest of the three invocation medians. Host: AMD Ryzen 9 5900X, Linux 7.3.3, Node 26.6.0 (V8 14.6) for xterm.js, rustc 1.96.1 release and the vendored libghostty-vt `ReleaseFast` for the core.

| Workload | Geometry | xterm.js `write()` MiB/s | xterm.js `writeSync` (private, no scheduling) | native core, VT and state only | Native over `write()` |
| --- | --- | --- | --- | --- | --- |
| W2 plain | 152x38 | 83.9 to 87.0 | 91.3 to 96.1 | 630 to 650 | 7.2 to 7.7 times |
| W2 plain | 46x37 | 72.7 to 74.9 | 80.8 to 84.0 | 395 to 422 | 5.3 to 5.8 times |
| W3 ANSI | 152x38 | 48.9 to 51.7 | 47.3 to 59.5 | 82.7 to 83.1 | 1.6 to 1.7 times |
| W3 ANSI | 46x37 | 45.9 to 53.0 | 56.8 to 61.4 | 83.5 to 84.0 | 1.6 to 1.8 times |
| W4 redraw | 152x38 | 105.6 to 106.6 | 116.1 to 117.3 | 676 to 681 | 6.3 to 6.4 times |
| W4 redraw | 46x37 | 93.6 to 95.0 | 103.5 to 104.4 | 348 to 352 | 3.7 to 3.8 times |

What this says, and does not say:

- **At the parse stage the core is faster on every baseline workload**, by 1.6 to 7.7 times at the median against the call the app makes (`write()`), and the order of the workloads is the same in both engines: ANSI-heavy output is the slowest to parse (about 83 MiB/s in the core and about 50 MiB/s in xterm.js) and plain text and redraws are the fastest. The margin is smallest exactly where it is most needed: style changes cost the core about eight times as much as plain text.
- **The parser was not what limited the recorded baseline.** xterm.js parses W3 at about 49 to 60 MiB/s here, while the recorded end-to-end W3 drain on the desktop viewport was a median of 4.3 MiB/s (22.0 on the phone viewport) and W2 was 40.1 (the same run figures as [above](#measured-baseline)). The remaining time in Chromium is the bridge decode, the DOM renderer and layout, so replacing the parser alone cannot move the end-to-end numbers by these ratios; this is the evidence, on the baseline's own bytes, for the plan's bet that the renderer and the bridge are the larger share. It is not a measurement of the native path end to end: no renderer, bridge, WebView or transport was in the loop for the core, and the xterm.js numbers are Node on V8, not Chromium and not a WebView.
- The two columns of xterm.js are the queued `write()` the app calls and the private synchronous parser entry (the upper bound without its scheduling); the core's column is its VT parse and state update with credit processing but without taking frames.
- Not measured: Android or any device, the core fed through the real bridge, `@xterm/xterm` with a renderer on the same bytes (the recorded baseline is that), and memory.

### Session service: pooled data path, flow control, input and memory (host microbenchmark, not a device baseline)

Measured with `cargo run --release --example session_bench` in `packages/terminal-runtime` ([#1315](https://github.com/mihazs/lazysh/issues/1315), [#1316](https://github.com/mihazs/lazysh/issues/1316), [#1319](https://github.com/mihazs/lazysh/issues/1319)). It drives the `Hub` (a fixed VT worker pool) the way a transport does: one producer thread per session takes credit from a 256 KiB window, feeds 16 KiB chunks, and the worker returns credit after VT processing. Same host and toolchain as the parse benchmark above (AMD Ryzen 9 5900X, Linux 7.3, rustc 1.96.1 release); the 1-minute load average at the start was 1.25 (pump slice 16 KiB, the default) and 0.64 (64 KiB), a much quieter host than the parse table. No transport, no JS bridge, no renderer, no xterm.js comparison, no device: it says nothing about Android and no ratio against the xterm.js baseline is valid.

Throughput and credit latency, plain text, 16 MiB per session, 80x24, 4 MiB scrollback, median of five runs (min to max); latency is the time from `feed` of a chunk to the credit that returns it, taken from the median run:

| Workers | Sessions | Aggregate MiB/s | Credit latency ms p50 / p95 / p99 |
| --- | --- | --- | --- |
| 1 | 1 | 656.9 (639.6 to 663.5) | 0.342 / 0.387 / 1.552 |
| 1 | 5 | 630.1 (617.9 to 633.2) | 1.796 / 2.114 / 7.731 |
| 2 | 5 | 990.7 (945.3 to 1017.1) | 0.896 / 1.771 / 6.308 |
| 1 | 10 | 556.2 (540.6 to 567.0) | 4.128 / 4.636 / 16.435 |
| 2 | 10 | 1016.8 (985.3 to 1078.6) | 2.141 / 2.545 / 11.963 |
| 4 | 10 | 1684.2 (1521.9 to 1720.2) | 1.064 / 2.026 / 8.217 |

Input to write: microseconds from the call of `send_key` to the writer holding the bytes (lock wait for a worker's slice on that very session, key encode, in-memory write), 5000 keys at 200 microsecond spacing, with the probe session and nine more flooding the same two workers:

| Case | Pump slice | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| Idle | 16 KiB | 0.3 | 0.5 | 1.6 | 18.6 |
| Flood of plain text | 16 KiB | 0.2 | 1.6 | 23.3 | 136.8 |
| Flood of CJK, emoji, combining | 16 KiB | 0.5 | 235.4 | 321.6 | 500.8 |
| Flood of plain text | 64 KiB | 0.3 | 0.7 | 35.1 | 613.1 |
| Flood of CJK, emoji, combining | 64 KiB | 0.4 | 772.5 | 1067.4 | 1259.9 |

The slice is the longest a key press can wait for the session lock, so the default is one transport chunk (16 KiB); the 64 KiB run is kept as the evidence for that choice (aggregate throughput of the 64 KiB run, taken at a different load, ranged from 1.5 percent lower to 7 percent higher across the six rows above, so 16 KiB costs little). These are encode-and-queue times on the host: the remote echo, the transport write and the display are not included, so they are not input-to-pixels latency.

Memory (resident set of the benchmark process, KiB): an empty session cost 8 KiB; each session that received 8 MiB of 80-column lines at the 4 MiB scrollback budget cost 3,923 KiB at 5 sessions and 3,921 KiB at 10, and the 100-session churn (create, 1 MiB of output each, close) held at 42,916 KiB across four rounds against 42,900 KiB before the first, so repeated create and close did not grow the process. `Session::close` frees the VT state at that moment, not at a later drop. These figures are for this host's allocator and libghostty-vt build; Android, iOS and Windows numbers do not exist yet.

The same churn through the Tauri bridge (`a_hundred_terminals_open_and_close_without_growing_the_process_or_the_budget`, `--features native-terminal`, one process on this host): 110 rounds of `terminal_core_open`, a real local PTY printing 30,000 lines into a 1 MiB scrollback (the budget was in bytes when these three runs were taken; since [the History lines mapping](#history-lines-to-scrollback-bytes-1319) the test opens with 1000 lines, a 1.8 MiB budget, and one run on this host held 63,160 KiB after the warm-up and grew by 0 KiB over the next 100 rounds), reading the screen text and `terminal_core_close`. After a 10-round warm-up the resident set was 65,436, 67,784 and 65,864 KiB in three runs and grew by 316, 316 and 352 KiB over the next 100 rounds; the hub held no session and no reserved scrollback afterwards. The test fails above 32 MiB of growth; that bound is a guard, not a target. Single-host figures: Android, iOS and Windows do not exist yet.

What this says, and does not say:

- Adding workers scales aggregate throughput (10 sessions: 556, 1017 and 1684 MiB/s at 1, 2 and 4 workers) while the per-session credit latency falls, so the pool size is a real lever and is set from per-device data, not from this host ([#1339](https://github.com/mihazs/lazysh/issues/1339)). One worker parses plain text at about 650 MiB/s here; the style-heavy and wide-character workloads were roughly 5 to 10 times slower in the parse table above (taken on a busier host) and are the ones to measure on devices.
- IPC calls per MB: the native path issues none per chunk (credits are returned inside Rust after VT processing). The xterm path issues one `ack_output` per `write` callback, so at the 16 KiB maximum chunk that is at least 64 calls per MiB by construction (smaller chunks mean more); the actual count depends on how the remote writes. Measured through a real OpenSSH server (the `openssh_and_mosh_deliver_checksummed_output_to_a_core` interoperability test, OpenSSH 10.6p1 on this host, a debug build, 5.62 MiB of `seq` output with CJK and emoji through a real PTY, one acknowledgement per message, four runs): a line-buffered writer (`sed`, flushing every line) crossed the Channel as 58,055, 69,090, 64,753 and 57,111 `Data` messages, 10,337, 12,302, 11,530 and 10,169 per MiB, so that many `ack_output` calls per MiB, far above the 64 minimum; a block writer (`| cat`) crossed as 9,595, 9,177, 7,068 and 10,029 messages, 1,708, 1,634, 1,259 and 1,786 per MiB. The count varies run to run with how the PTY and the SSH channel coalesce. The same two workloads into a core crossed the Channel as zero `Data` messages. The same test file also runs 100,000 lines through the official ET 7.0.0 server into a core: the 1,888,895 bytes the workload printed between two markers were byte-identical to the expected output, with 262,143 bytes (the 256 KiB window minus one) the most ever queued unreturned and no `Data` message on the Channel. These are message and byte counts, not time: no throughput or CPU was taken in these tests.
- **The bridge, Rust side only** (`bridge_throughput_channel_versus_core` in `ssh.rs`, run with `cargo test --features native-terminal --lib bridge_throughput -- --ignored --nocapture`; built with opt-level 3 and no LTO, which is not the release profile). 64 MiB of 80-column text through `send_output` on this host, three runs, load average 3 to 4 at the start. The Channel path with a renderer that acknowledges every chunk the instant it is sent (an upper bound for the xterm path): 154, 151 and 152 MiB/s, 0.42 CPU s per 64 MiB, 64 Channel messages per MiB (the JSON serialization of `SshEvent::Data` is the cost). The core path (real libghostty-vt on the hub's workers, credit returned after VT processing): 666, 658 and 642 MiB/s, 0.11 to 0.12 CPU s per 64 MiB, zero Channel messages. The same test in a debug build ran the Channel path at 8 MiB/s, so a debug figure says nothing. These two are **not like for like**: the core's CPU includes VT parsing, which on the Channel path happens later in the WebView and is absent here, and none of the WebView decode, the xterm parse, the `ack_output` IPC or any rendering is measured. They bound the Rust-side cost of the data path; the comparison with the #1303 baseline needs the renderer wired in and a device.
- With several sessions the p99 credit latency is 3 to 4 times the p95 (up to 16 ms with 10 sessions on one worker). The cause was not investigated; shared-host scheduling of the producer and worker threads is a candidate, queueing behind other sessions' windows is another.

### Active-session screen update latency with nine sessions flooding (host microbenchmark, not a device baseline)

Measured with `cargo run --release --example session_bench screen` in `packages/terminal-runtime` ([#1339](https://github.com/mihazs/lazysh/issues/1339)). One attached session (the one on screen) receives a 6-byte chunk, the echo of a key, every millisecond; the number is the time from `Session::feed` to `Hooks::changed` firing, which is when its screen update is ready to be taken and drawn. Nine more sessions on the same hub flood plain text or CJK, emoji and combining marks in a loop for the whole run, so every worker always has several sessions with 256 KiB of bytes queued. 2000 echoes per row. It covers the queueing before the VT parses the echo, not the transport, the JS bridge, the render or the display, so it is not input-to-pixels latency, no xterm.js comparison was run, so no ratio is claimed, and it says nothing about a phone.

Same host as the tables above (AMD Ryzen 9 5900X, Linux 7.3.3, rustc 1.96.1 release, the vendored libghostty-vt built `ReleaseFast`, 16 KiB pump slice, default 2 workers unless the row says 1). Three invocations before and three after the change below, at 1-minute load averages of 7.6 to 11.1 on 24 threads; the cells are the lowest and highest of the three invocations.

| Row | Before: p50 | Before: p99 | After: p50 | After: p99 |
| --- | --- | --- | --- | --- |
| idle, 2 workers | 4.6 to 7.5 | 16.5 to 52.6 | 4.2 to 7.0 | 13.8 to 1615 |
| 9 sessions flooding plain text, 1 worker | 239 to 324 | 363 to 636 | 17.1 to 17.8 | 65 to 75 |
| 9 sessions flooding plain text, 2 workers | 99 to 183 | 167 to 488 | 17.0 to 20.6 | 71 to 83 |
| 9 sessions flooding CJK/emoji/combining, 1 worker | 2259 to 2428 | 2987 to 3869 | 156 to 158 | 334 to 563 |
| 9 sessions flooding CJK/emoji/combining, 2 workers | 1044 to 1062 | 1891 to 2326 | 139 to 159 | 469 to 716 |

Microseconds. The change is the one in `hub.rs`: a worker's run queue is two queues, attached sessions first, with one detached turn after every four attached ones in a row. Before it, the queue was first-in, first-out, so an echo waited behind a turn of every flooding session on its worker (nine turns of 16 KiB with nine floods on one worker; the test below counted 147,456 bytes parsed for other sessions in between). After it the echo waits for the turn in progress. By arithmetic from the parse throughput above, not measured separately, a 16 KiB turn takes about 26 microseconds for plain text (612 MiB/s) and about 230 for the CJK workload (roughly 70 MiB/s), which is the size of the remaining 17 and 157 microseconds p50.

- The idle row is unchanged by the change. One of the three "after" invocations had an idle p99 of 1615 microseconds and a p95 of 190 against 17 and 11 in the other two, at the highest load of the series; that is host noise on a shared machine, not the change, but it is why the idle p99 cell above is a range of two orders of magnitude and not a number.
- Detached sessions are not starved: `a_detached_session_keeps_parsing_while_the_attached_one_never_idles` refills an attached session from its own credit hook so it never idles, and a detached one still finishes (it fails by timeout with the burst removed, and the other test fails on the old queue with 147,456 bytes parsed ahead of the echo against a bound of 65,536).
- Not measured: the cost to the detached sessions (their credit latency while an attached one floods rises by construction to one turn in five on a worker; its size was not recorded), a phone, more or fewer than nine other sessions, split panes with several attached sessions (they share the priority queue and round-robin), and how many workers a device should have. Worker count stays a placeholder: the throughput table above shows the pool size is a real lever on this host and nothing else.

### History lines to scrollback bytes (#1319)

lazysh's History lines setting counts lines (100 to 20000, default 5000); libghostty-vt budgets bytes, and the rows one budget holds depend on the width and the content. `cargo run --release --example scrollback_budget` in `packages/terminal-runtime` measures it with the workloads of `tests/support/mod.rs`: 16 MiB of budget, each width fed far past the budget, then the rows the core reports. Host: AMD Ryzen 9 5900X, 31 GiB, Linux 7.3.3-1-cachyos, rustc 1.96.1, Zig 0.16.0 (the numbers are deterministic across invocations; no device was involved).

| Content, rows kept by a 16 MiB budget (bytes per cell) | 20 cols | 40 cols | 80 cols | 120 cols | 200 cols | 279 cols |
| --- | --- | --- | --- | --- | --- | --- |
| Plain digits | 91,156 (9.2) | 46,243 (9.1) | 23,336 (9.0) | 15,702 (8.9) | 9,300 (9.0) | 6,663 (9.0) |
| 16-colour SGR runs with bold | 91,156 (9.2) | 46,243 (9.1) | 23,336 (9.0) | 15,702 (8.9) | 9,300 (9.0) | 6,663 (9.0) |
| Truecolor syntax-highlight runs | 91,156 (9.2) | 46,243 (9.1) | 23,336 (9.0) | 15,702 (8.9) | 9,300 (9.0) | 6,663 (9.0) |
| A different truecolor foreground and background on every cell | 15,234 (55.1) | 7,381 (56.8) | 3,684 (56.9) | 2,544 (55.0) | 1,611 (52.1) | 985 (61.0) |
| ZWJ emoji, wide CJK, combining marks | 37,564 (22.3) | 11,953 (35.1) | 5,996 (35.0) | 4,092 (34.2) | 2,310 (36.3) | 1,653 (36.4) |
| A distinct OSC 8 hyperlink on every row | 30,865 (27.2) | 15,382 (27.3) | 7,730 (27.1) | 5,253 (26.6) | 3,009 (27.9) | 2,154 (27.9) |

Styles are shared per page, so colour costs nothing until a page runs out of distinct styles; graphemes and hyperlinks cost extra bytes per cell. `scrollback_bytes_for_lines(lines, cols)` requests `lines x max(cols, 80) x 10 + 1 MiB` (10 bytes per cell is the measured 8.9 to 9.2 with margin; the MiB covers libghostty-vt freeing whole pages, which loses up to a page and a half of a small budget). Rows kept at that budget divided by the requested lines, after feeding three times the lines (the ordinary workloads are identical; a value near 3.00 means the budget was not yet full):

| Lines | 20 cols | 40 cols | 80 cols | 120 cols | 200 cols | 279 cols |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | 2.77 | 2.77 | 2.77 | 2.77 | 2.77 | 2.77 |
| 1000 | 2.98 | 2.98 | 1.82 | 1.82 | 1.58 | 1.47 |
| 5000 | 3.00 | 2.54 | 1.38 | 1.29 | 1.22 | 1.23 |
| 20000 | 3.00 | 2.37 | 1.21 | 1.18 | 1.18 | 1.17 |

At 5000 lines the three expensive contents keep, per width from 20 to 279 columns: 0.76, 0.25, 0.22, 0.21, 0.20 and 0.19 of the requested lines for a style on every cell; 2.10, 0.48, 0.34, 0.36, 0.29 and 0.32 for graphemes; 1.66, 0.71, 0.45, 0.44, 0.39 and 0.39 for a hyperlink on every row. When the hub grants the full calculated budget, the setting is a floor for ordinary output at the width the session opened with, and an overestimate for content that defeats cell sharing. Before the mapping, the 4 MiB default kept about 5,300 rows of plain text at 80 columns and about 2,200 at 200. What this does not say: no device figure exists (Android and iOS cannot link the core yet), the width is fixed at open (a session that opens at 45 columns is budgeted as 80, one widened to 200 afterwards keeps fewer rows of what it prints next), the hub's 64 MiB per-session cap clamps the largest setting (20000 lines) at about 330 columns and wider, and the remaining global budget can reduce the grant further.

### Scrollback compaction of idle sessions (host microbenchmark, not a device baseline)

Measured with `cargo run --release --example compress_bench` and `cargo run --release --example session_bench memory` in `packages/terminal-runtime` ([#1338](https://github.com/mihazs/lazysh/issues/1338)). A detached session that has received nothing for `HubConfig::compress_after` (2 s by default) has its scrollback compacted by its worker with libghostty-vt's incremental compression, one bounded step at a time and only while no session on that worker has bytes to parse. An attached session is never compacted, and new output or an attach cancels a pending compaction. Same host and toolchain as the tables above (AMD Ryzen 9 5900X, Linux 7.3.3, rustc 1.96.1 release, vendored libghostty-vt built `ReleaseFast`); `compress_bench` and `session_bench memory` ran three times each on 2026-11-18 on top of `origin/main` at `ec4ad0f5`, at 1-minute load averages of about 8 to 11 on 24 threads. No transport, no renderer, no xterm.js side by side and no device.

`compress_bench`: ten sessions (80x24, the default 4 MiB scrollback) each receive 8 MiB; resident memory per session is the growth of the process over ten sessions; every pass asserts the full text is unchanged and the row count equal. The cells are the lowest to highest of the three runs.

| Content | Rows kept | RSS KiB per session, filled | after compaction | Compaction ms per session (worst single step) | Reading the whole history ms, before and after | Attach snapshot ms, before and after |
| --- | --- | --- | --- | --- | --- | --- |
| plain text | 5280 | 4021 to 4032 | 646 to 652 | 0.7 to 0.8 (0.08) | 1.7 to 1.8, 3.0 to 5.2 | 0.24 to 0.25, 0.24 to 0.39 |
| ANSI + truecolor | 4892 | 3352 to 3359 | 563 to 570 | 2.4 to 2.5 (0.29 to 0.42) | 0.7 to 1.3, 2.4 to 3.4 | 0.15 to 0.28, 0.17 to 0.19 |
| CJK/emoji/combining | 5030 | 3829 to 3835 | 341 to 347 | 1.1 to 1.2 (0.16 to 0.17) | 1.6 to 1.9, 2.9 to 3.0 | 0.16 to 0.17, 0.16 to 0.18 |
| plain lines, 80 columns | 5280 | 3920 | 392 | 0.8 to 0.9 (0.10 to 0.23) | 1.4, 2.6 to 2.8 | 0.18, 0.18 to 0.19 |

Through the hub (`session_bench memory`, sessions filled with 8 MiB of 80-column lines at a 4 MiB scrollback, then left detached for 3 s with the default 2 s delay), resident memory per session, lowest to highest of three runs:

| Sessions | Filled | After 3 s idle and detached |
| --- | --- | --- |
| 5 | 3986 to 3999 KiB | 534 to 547 KiB |
| 10 | 3947 to 3960 KiB | 474 to 488 KiB |

Churn (100 sessions, 1 MiB each, created and closed per round) over 40 rounds with compaction on: in each of three runs the process stayed within 64 to 192 KiB of its round-1 value through round 40 (14,364 to 14,428, 15,980 to 16,064 and 15,872 to 16,032 KiB; the baseline differs between invocations), and with it off between 15,028 and 15,192 KiB (the run of 2026-11-14). A first version that kept a closed session's pending compaction until its timer grew by about 1.4 MiB over the first 12 rounds and then held flat; closing a session now drops that entry, and the figures above are from the version that does.

How this compares with the recorded xterm.js baseline, and why that comparison is weak: the [baseline](#measured-baseline) measured 7.2 to 8.3 MiB of renderer-process resident memory per session at 5 and 10 sessions with 5000 lines each (whole renderer process, DOM renderer, 152 or 46 columns, hidden panes), and 0.8 to 1.2 MiB of JS heap. The native figures above are the Rust core's process only, at 80 columns, with about 5280 rows kept, no renderer surface and no WebView; they are not the same quantity and no ratio is claimed. They do show that ten sessions cost about 40 MiB while all are active and about 8 MiB when nine are idle and detached (9 x 0.49 + 3.96), against 73 to 77 MiB of baseline renderer growth for ten sessions.

What this says, and does not say:

- The saving is real on this host: 83 to 91 % of a full session's resident memory returned, history intact (asserted on every pass), at a cost of 0.7 to 2.5 ms of worker time per session, no single step above 0.42 ms in these runs, and about 1.2 to 3.5 ms more the first time the whole history is read afterwards. An attach snapshot, which reads the visible screen, did not change.
- What is not known: whether the reclamation works on Android, iOS and Windows (the library reports it as unsupported on some targets, in which case a step does nothing and the saving is zero), what a phone's allocator does with the freed pages, the cost of scrolling back into a compacted history on a device, and any energy cost of the periodic wake. Linux x86_64 with glibc is the only target measured.
- The 2 s delay is a placeholder: it keeps a session that gets output every few seconds from being compacted and restored in turn, and nothing measured here chose it.
- `HubConfig::scrollback_budget` (256 MiB) and `session_scrollback_max` (64 MiB) are unchanged placeholders: with compaction ten full sessions cost about 8 MiB on this host, which is not evidence for any particular device budget, and the mapping of the History lines setting to bytes is a separate change.

`perf_gate` holds this in CI ([#1341](https://github.com/mihazs/lazysh/issues/1341); see [Regression benchmarks in CI](#regression-benchmarks-in-ci)): the filled and the idle figure at 5 and at 10 sessions. Idle sessions are measured through the hub with a 100 ms delay and counted once every session has stepped and none has for 300 ms. Three invocations on the host above gave 617 to 620 KiB per session at 5 sessions and 454 to 455 KiB at 10, against a limit of 1,500 KiB; `--inject nocompaction` (a hub that never compacts) gave 4,042 and 3,930 KiB and failed both. This is the host half of gate G15; the Waydroid half stays with [#2093](https://github.com/mihazs/lazysh/issues/2093) and was not run here.

### Renderer pipeline cost (host microbenchmark, not a candidate)

Measured with `cargo run --release --example render_bench` in `packages/terminal-runtime` ([#1322](https://github.com/mihazs/lazysh/issues/1322)). It adds the stages above the VT, one at a time, to the same kind of 16 KiB feed as the parse benchmark: `take_frame`, the renderer-side `Screen::apply` plus its dirty-row query, and the CPU reference renderer's draw and present. Frames are taken either after every 16 KiB chunk or once per 256 KiB of output (the credit window, the most that can be in flight); the second is what a renderer that draws once per display refresh sees at best. The reference renderer is a correctness vehicle with a dot-pattern glyph and no font; its row is the cost of a software renderer, not of a candidate. Every reference run ends by checking that its incrementally drawn image equals a full repaint of the final screen. No transport, JS bridge, GPU or device is involved, and none of this may be compared with the xterm.js baseline: its generators are not W2 to W4.

Environment: AMD Ryzen 9 5900X (24 threads), Linux 7.3.3, rustc 1.96.1 release profile, libghostty-vt from the vendored Ghostty commit `44f2a44df` built with Zig 0.16.0 `ReleaseFast`, x86_64. Host load average at start 13.3 (1 minute); other agents shared the machine, so absolute figures move between runs: four runs at load averages 1.1, 6.3, 7.7 and 13.3 gave 618, 656, 702 and 680 MiB/s for VT-only plain text at 80x24 (a 14 % spread), and the table is the last one, taken with the final code ([raw output](benchmarks/terminal-render-bench-1.txt)). A fifth run of the same code rebased on a later `main` (load average 14.1, same host and toolchain) is committed as [raw output](benchmarks/terminal-render-bench-2.txt): its cells agree with the table within the run-to-run spread above (for example 80x24 plain text per chunk: 638, 78.0, 66.6 and 14.3 MiB/s against 680, 78.4, 69.6 and 14.8), and its reference stage passed the incremental-equals-full-repaint check. 16 MiB per workload, 5 runs, MiB/s median with minimum and maximum. Grids are 80x24 and 152x38 (the desktop baseline geometry); the redraw fixture repaints 24 rows of 80 columns, so it touches 24 rows on either grid.

| grid | workload | frame cadence | VT only | + take_frame | + Screen::apply | + reference draw and present | frames | rows drawn | MiB uploaded |
|---|---|---|---|---|---|---|---|---|---|
| 80x24 | plain text | per chunk | 680.1 (457.4 to 690.2) | 78.4 (76.5 to 79.9) | 69.6 (66.6 to 70.8) | 14.8 (14.8 to 15.1) | 1024 | 24576 | 720.0 |
| 80x24 | plain text | per window | 683.0 (630.9 to 686.5) | 462.0 (452.6 to 470.3) | 439.5 (406.5 to 444.6) | 179.1 (172.6 to 180.9) | 64 | 1536 | 45.0 |
| 80x24 | ANSI + truecolor | per chunk | 71.8 (70.9 to 73.4) | 44.7 (43.3 to 45.4) | 41.5 (41.1 to 42.2) | 18.9 (18.5 to 19.2) | 1024 | 24576 | 720.0 |
| 80x24 | ANSI + truecolor | per window | 73.3 (72.1 to 73.4) | 70.8 (69.2 to 71.3) | 69.8 (68.7 to 70.7) | 61.4 (60.7 to 63.4) | 64 | 1536 | 45.0 |
| 80x24 | full-screen redraw | per chunk | 402.7 (393.3 to 403.4) | 68.2 (66.7 to 68.3) | 61.6 (61.3 to 61.8) | 21.9 (21.7 to 22.0) | 1024 | 24576 | 720.0 |
| 80x24 | full-screen redraw | per window | 402.3 (395.0 to 404.1) | 303.0 (272.5 to 311.0) | 298.0 (276.1 to 298.7) | 188.5 (187.3 to 191.5) | 64 | 1536 | 45.0 |
| 80x24 | CJK/emoji/combining | per chunk | 66.6 (62.4 to 71.6) | 42.3 (41.7 to 43.4) | 39.8 (39.3 to 40.4) | 16.0 (15.8 to 16.1) | 1024 | 24576 | 720.0 |
| 80x24 | CJK/emoji/combining | per window | 70.2 (68.1 to 71.9) | 65.9 (63.6 to 67.1) | 68.0 (66.1 to 68.3) | 54.6 (52.8 to 57.7) | 64 | 1536 | 45.0 |
| 152x38 | plain text | per chunk | 556.7 (524.9 to 574.1) | 35.1 (34.5 to 35.6) | 30.9 (30.4 to 31.1) | 6.7 (6.2 to 7.0) | 1024 | 38912 | 2166.0 |
| 152x38 | plain text | per window | 565.9 (505.0 to 613.6) | 304.3 (293.4 to 307.5) | 277.5 (270.8 to 281.8) | 89.5 (86.6 to 92.9) | 64 | 2432 | 135.4 |
| 152x38 | ANSI + truecolor | per chunk | 47.9 (45.9 to 49.5) | 22.5 (21.7 to 22.9) | 20.8 (20.6 to 21.4) | 7.5 (5.4 to 8.1) | 1024 | 38912 | 2166.0 |
| 152x38 | ANSI + truecolor | per window | 47.6 (46.3 to 49.5) | 37.9 (29.0 to 43.3) | 36.6 (34.3 to 45.8) | 31.7 (25.3 to 36.1) | 64 | 2432 | 135.4 |
| 152x38 | full-screen redraw | per chunk | 324.0 (247.7 to 397.4) | 45.5 (37.4 to 48.4) | 41.6 (37.5 to 43.9) | 14.4 (13.7 to 14.4) | 1024 | 24590 | 1368.8 |
| 152x38 | full-screen redraw | per window | 393.0 (307.1 to 405.4) | 267.3 (230.8 to 274.1) | 259.9 (226.5 to 266.7) | 144.7 (142.7 to 146.1) | 64 | 1550 | 86.3 |
| 152x38 | CJK/emoji/combining | per chunk | 41.7 (36.2 to 42.6) | 20.7 (19.7 to 21.0) | 19.6 (19.4 to 19.9) | 7.1 (7.0 to 7.2) | 1024 | 38912 | 2166.0 |
| 152x38 | CJK/emoji/combining | per window | 42.1 (40.6 to 42.4) | 39.0 (37.7 to 39.7) | 39.1 (38.3 to 39.3) | 31.8 (31.7 to 32.3) | 64 | 2432 | 135.4 |

What this says, and does not say:

- **Making a frame costs several times what parsing does.** For plain text on 80x24 the VT alone ran at 680 MiB/s and 78 MiB/s with a frame after every chunk; at 152x38, 557 against 35. Plain text and redraws, which parse fast, lose 83 to 94 % of their throughput; style-heavy and Unicode-heavy output parses slowly (42 to 73 MiB/s) and loses 36 to 53 %. The owned `String` per cell of `Frame` is the likely cause, which this run did not isolate; [#1337](https://github.com/mihazs/lazysh/issues/1337) owns the compact format.
- **Taking one frame per 256 KiB instead of per 16 KiB recovers most of it** for plain text (78 to 462 MiB/s at 80x24) and redraws (68 to 303). A renderer scheduled once per display refresh therefore matters more than the renderer implementation for output bursts.
- **`Screen::apply` is a small addition** (from within noise to 12 % below the frame-only figure), but it copies every dirty row's cells once more.
- **The CPU reference renderer** adds a further factor of 1.1 to 4.7 over `Screen::apply` and uploads (copies) whole pixel rows: with a frame per chunk each of the 1024 frames redraws every row of a scrolling screen, 720 MiB copied for 16 MiB of text at 80x24. It is not a performance candidate and no GPU or font cost is represented.
- Nothing here says which renderer wins on any device.

### WebAssembly VT versus xterm.js, parse only (host microbenchmark, not a candidate)

Measured with `apps/client/bench/wasmVt.mjs` ([#1323](https://github.com/mihazs/lazysh/issues/1323)): the parse stage of the "WASM terminal" candidate, on the byte fixtures of the Rust benchmarks (`cargo run --release --example dump_workloads -- <dir>` writes them), in Node, so xterm.js and WebAssembly run on the same V8. The WebAssembly module is libghostty-vt built from the vendored, hash-checked source, unmodified, in a copy outside the checkout (`zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast -Dsimd=false`, Zig 0.16.0; 4.5 MiB, no imports); no prebuilt third-party module was used, so [#384](https://github.com/mihazs/lazysh/issues/384) is not affected. xterm.js is `@xterm/headless` 5.5.0, the same parser and buffer as `@xterm/xterm` 5.5.0 without a renderer or DOM, scrollback 5000 lines. The wasm terminal has a 4 MiB scrollback byte budget (the native runtime's default). Each run creates a fresh terminal and feeds 16 MiB in 16 KiB chunks, copied into wasm linear memory the way a WebView bridge would hand over an `ArrayBuffer`; five runs, MiB/s median (min to max).

Environment: AMD Ryzen 9 5900X, Linux 7.3.3, Node v26.6.0 (V8 14.6), host load average at start 4.84 (1 minute) with other agents running. The cursor position after the run must agree between engines and the wasm run fails if its terminal shows no output.

The table is the first run ([raw output](benchmarks/terminal-wasm-vt-bench-1.txt)). A second run of the same script and module on the same host, taken later at a load average of 20.3 with other builds running, is committed as [raw output](benchmarks/terminal-wasm-vt-bench-2.txt): the WebAssembly parser was again faster than `write()` on every fixture, by 6.0, 1.5, 3.0 and 2.0 times in the table's order (460, 73, 206 and 104 MiB/s against 77, 49, 68 and 53), with a wider spread (ANSI + truecolor: 33 to 83 MiB/s for WebAssembly).

| Workload (80x24) | xterm.js `write()` | xterm.js `writeSync` (private, no scheduling) | libghostty-vt wasm | cursor after, xterm / wasm | wasm linear memory MiB |
| --- | --- | --- | --- | --- | --- |
| plain text | 84.2 (74.3 to 88.6) | 94.1 (93.2 to 95.7) | 488.3 (477.5 to 499.0) | 10,23 / 10,23 | 5 |
| ANSI + truecolor | 61.0 (59.6 to 62.1) | 66.8 (63.6 to 67.1) | 81.9 (81.4 to 82.0) | 21,23 / 21,23 | 9 |
| full-screen redraw | 101.9 (101.1 to 104.1) | 113.3 (112.5 to 113.7) | 281.8 (277.9 to 284.9) | 52,11 / 52,11 | 1 |
| CJK/emoji/combining | 67.7 (57.5 to 68.9) | 73.2 (72.6 to 74.6) | 118.3 (117.7 to 118.9) | 0,23 / 0,23 | 8 |

What this says, and does not say:

- **On this V8 the WebAssembly parser was faster than xterm.js's JS parser on every fixture**: 5.8 times on plain text (488 against 84 MiB/s through `write()`, 5.2 against the private synchronous call), 2.8 times on redraws, 1.7 times on non-ASCII text and 1.3 times on ANSI-heavy text (82 against 61). Style-heavy output is where every parser is slowest, and the gap is smallest there. `write()` pays xterm.js's own scheduling (it yields between slices), so the synchronous column is the fairer parser-to-parser comparison, which it only narrows.
- **The two engines agreed on the cursor after every fixture**, so they consumed the same stream. This is not a conformance result: the cursor does not show cell contents, and widths of emoji and combining sequences were not compared cell by cell (the VT conformance corpus in `packages/terminal-runtime/tests/conformance.rs` runs on the native build only).
- **Native Rust is not faster by construction.** For the same fixtures the native runtime (through `TerminalRuntime::offer` and `pump`, SIMD on) measured 200 to 729, 40 to 75, 216 to 403 and 38 to 74 MiB/s over ten invocations at load 13 to 175 ([above](#core-parse-throughput-host-microbenchmark-not-a-device-baseline)); the wasm figures are inside or above those ranges. The two are not the same harness (the native one adds an ingress copy and runtime bookkeeping, and SIMD is on only there), and why the wasm number for non-ASCII text exceeds the native one was not investigated.
- **Parsing is not most of what xterm.js costs on this host.** In the [baseline](#measured-baseline) 2 MiB of ANSI colour (W3, desktop viewport) ran at a median 4.3 MiB/s (464 ms of wall time) through `xterm.write` with the DOM renderer, against 61 MiB/s (about 33 ms) for the parser alone here, and plain text (W2) at 40 MiB/s against 84. The generators differ, so these are orders of magnitude, not ratios; the remainder is rendering and layout, which this table does not cover. A WASM terminal still needs a renderer in the WebView (DOM, canvas or WebGL), which is the [xterm.js renderer shootout](#renderer-shootout-xtermjs-renderers-1323) again, plus a JavaScript bridge that carries every byte and every dirty row.
- Not shown: Chromium or an Android WebView (a different V8 version and flags), WebAssembly SIMD, a worker thread, memory growth under a long session (the linear memory never shrinks), loading the module in a WebView (asset fetch, streaming compilation, V8 code cache), any rendering, energy, or any device. The cold start of the module in Node is measured [below](#wasm-terminal-cold-start-node-fresh-process-per-sample).

#### WASM terminal cold start (Node, fresh process per sample)

Measured with `apps/client/bench/wasmStartup.mjs` ([#1323](https://github.com/mihazs/lazysh/issues/1323)), the same module as above (libghostty-vt from the vendored, hash-checked source, `zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast -Dsimd=false`, Zig 0.16.0, 4,675,760 bytes, sha256 in the raw files) and `@xterm/headless` 5.5.0 on the same Node v26.6.0 (V8 14.6) and the Ryzen 9 5900X host (Linux 7.3.3, load average at start 6.5 and 6.0, other agents running). Each sample is a fresh process that does the least that parses 14,800 bytes (a styled, wide and emoji text sample, the same bytes for both) from nothing loaded: xterm.js imports the package, creates an 80x24 terminal with 5000 lines of scrollback and writes through the private synchronous call; the module reads the file, compiles it, instantiates it, creates an 80x24 terminal with the module's default scrollback and writes through linear memory. 30 processes per engine, upper median (min to max) in milliseconds and MiB; the cursor after the write was checked equal between the engines and over all samples. Two runs, [raw output 1](benchmarks/terminal-wasm-startup-1.txt) (below) and [raw output 2](benchmarks/terminal-wasm-startup-2.txt), taken a minute or two apart.

| engine | load (import or file read) | compile | instantiate | start through sample parsed, total | resident set added | wasm linear memory |
| --- | --- | --- | --- | --- | --- | --- |
| xterm.js headless | 8.7 (8.5 to 10.7) | | | 21.6 (18.3 to 24.5) | 9.3 (7.2 to 10.1) | |
| libghostty-vt wasm | 2.6 (2.5 to 2.7) | 2.2 (1.6 to 2.7) | 0.3 (0.3 to 0.4) | 8.1 (7.5 to 11.4) | 14.0 (13.6 to 18.0) | 1.3 (1.3 to 1.3) |

- **The module completed startup and parsing sooner than xterm.js did**: 8.1 against 21.6 ms through the sample in the first run and 8.0 against 21.3 ms in the second, about 2.7 times. Compiling the 4.5 MiB module took 2.2 ms (V8 compiles lazily, so part of the cost moves into the first calls, which the total includes) and instantiating it 0.3 ms.
- **It held more resident memory**: 14.0 MiB added to the process against 9.3 (9.1 in the second run) for xterm.js, 4.7 to 4.9 MiB more, which includes the 4.5 MiB buffer the file is read into. Its linear memory was 1.3 MiB after the first write and 1 to 9 MiB after 16 MiB of output ([above](#webassembly-vt-versus-xtermjs-parse-only-host-microbenchmark-not-a-candidate)).
- **What this does not say.** The "load" column of xterm.js is Node importing a CommonJS package, not a WebView parsing an app bundle, so the two load figures are not comparable; a WebView streams and caches compiled code differently; xterm.js here has no renderer and no DOM (the app's session also pays for those); the host CPU is far faster than a phone's, and the cold start on a phone is unmeasured. Parse throughput and cold start together do not change the [decision](adr-0001-terminal-runtime.md#amendment-2-2026-11-13-native-candidates-measured-on-the-host-and-on-waydroid): the WASM terminal still needs a renderer in the WebView and a JavaScript bridge that carries every byte and dirty row, and neither a faster parser nor an 8 ms start removes that.

### wgpu prototype against the CPU reference renderer (host GPU, not a device)

Measured with `cargo run --release --example wgpu_bench` in `packages/terminal-runtime/prototypes/wgpu` ([#1323](https://github.com/mihazs/lazysh/issues/1323); that directory was promoted to [`packages/terminal-renderer-wgpu`](../../packages/terminal-renderer-wgpu/README.md) by [#1324](https://github.com/mihazs/lazysh/issues/1324), and the numbers below were taken before the promotion, with the prototype's code; the [next section](#wgpu-renderer-idle-atlas-and-memory-host-gpu-not-a-device) measures the production crate): the wgpu candidate, prototype quality, implementing the same `TerminalRenderer` trait as the CPU reference renderer and fed the same `Frame` stream from the real libghostty-vt core. It consumes the shared layout (`layout::row_draws`): each draw becomes one instance of an instanced quad (a solid rectangle, or a glyph mask taken from an atlas), the dirty rows' instances are uploaded once per frame and drawn in one pass into an offscreen `Rgba8Unorm` texture. It is **offscreen and headless**: no window, swapchain or compositor, so `present` waits for the GPU to finish what `draw` submitted (the latest moment a swapchain image could be shown), and what the table calls a frame is draw (instance build, upload, encode, submit) plus that wait. It draws the reference renderer's dot-pattern glyphs, not text: no fonts, shaping, fallback or atlas eviction.

**Correctness against the oracle.** `tests/vs_reference.rs` feeds the same frames to both renderers and requires identical pixels: ASCII, bold, faint, inverse, hidden, every underline style with a colored underline, strike-through, overline, wide, combining and emoji clusters, the four cursor shapes (including on a wide character), linear and block selection, 40 incremental frames against the CPU renderer after each one, and recovery from a destroyed device (`DeviceLost` on every call, `resume`, snapshot). All four pass; the test fails if one color channel is swapped in the shader (checked by hand), and refuses to compare against a blank oracle image. This is the golden-image check of [#1322](https://github.com/mihazs/lazysh/issues/1322) applied to a GPU implementation; it does not show anything about text.

Environment: AMD Radeon RX 5500 XT (RADV NAVI14), Vulkan 1.4, Mesa 26.2.6, wgpu 30.0.2 on the Vulkan backend, discrete GPU; the CPU is the Ryzen 9 5900X host of the other measurements, shared with other builds and agents (load average at start 8.23); Linux 7.3.3, rustc 1.96.1 release profile. 16 MiB per workload, 5 runs, 80x24 and 152x38 grids of 8x16 pixel cells, a frame after every 16 KiB chunk or every 256 KiB. The pipeline column is MiB/s through VT, `take_frame` and the renderer; frame ms is draw plus present per frame, p50 / p99 over all runs.

The table is the first run ([raw output](benchmarks/terminal-wgpu-bench-1.txt)). A second run of the same code on a later `main` (host load average 4.1, a quieter machine) is committed as [raw output](benchmarks/terminal-wgpu-bench-2.txt). It gives the same picture: the wgpu frame was 1.6 to 3.5 times cheaper at the median (0.24 to 0.71 ms against 0.44 to 1.84 ms), the whole pipeline 0.74 to 2.2 times faster (one row was slower than the reference, within the spread of its 5 runs) and the wgpu p99 was higher than the reference's in 6 of the 16 rows. A run taken in between at load 15.8 agreed within the same ranges (frame 1.5 to 4.5 times, p99 higher in 6 rows) and was not kept.

Startup and memory (one run): the first renderer took 271 ms to create (instance, adapter, device, pipeline; 33 ms in an earlier run of the same code before the lifecycle refactor, so one run says little about startup) and added 62,288 KiB to the resident set of the process (the Vulkan driver and shader compiler), four more added 12,804 KiB together (about 3.1 MiB each, 80x24).

| grid | workload | frame cadence | reference MiB/s | reference frame ms | wgpu MiB/s | wgpu frame ms | frames | rows drawn | reference MiB copied | wgpu MiB uploaded |
|---|---|---|---|---|---|---|---|---|---|---|
| 80x24 | plain text | per chunk | 14.7 (14.4 to 14.8) | 0.815 / 1.305 | 27.7 (26.4 to 28.1) | 0.306 / 0.588 | 1024 | 24576 | 720.0 | 109.96 |
| 80x24 | plain text | per window | 176.7 (170.5 to 177.6) | 0.816 / 1.373 | 266.6 (260.9 to 269.1) | 0.303 / 1.919 | 64 | 1536 | 45.0 | 6.88 |
| 80x24 | ANSI + truecolor | per chunk | 18.6 (17.5 to 19.0) | 0.448 / 0.835 | 22.3 (22.1 to 23.0) | 0.258 / 0.508 | 1024 | 24576 | 720.0 | 74.43 |
| 80x24 | ANSI + truecolor | per window | 59.3 (53.9 to 60.5) | 0.472 / 0.866 | 62.4 (59.0 to 63.1) | 0.289 / 1.747 | 64 | 1536 | 45.0 | 4.65 |
| 80x24 | full-screen redraw | per chunk | 21.3 (20.9 to 21.3) | 0.461 / 0.669 | 29.2 (28.3 to 29.4) | 0.250 / 0.359 | 1024 | 24576 | 720.0 | 76.97 |
| 80x24 | full-screen redraw | per window | 180.4 (174.6 to 182.6) | 0.464 / 0.757 | 201.5 (187.5 to 209.5) | 0.288 / 1.731 | 64 | 1536 | 45.0 | 4.81 |
| 80x24 | CJK/emoji/combining | per chunk | 15.7 (15.4 to 15.8) | 0.584 / 0.898 | 22.7 (22.7 to 23.1) | 0.260 / 0.373 | 1024 | 24576 | 720.0 | 67.27 |
| 80x24 | CJK/emoji/combining | per window | 59.5 (58.9 to 59.8) | 0.590 / 0.706 | 62.0 (59.2 to 63.1) | 0.298 / 2.041 | 64 | 1536 | 45.0 | 4.21 |
| 152x38 | plain text | per chunk | 6.9 (6.9 to 6.9) | 1.720 / 2.126 | 15.2 (15.1 to 15.5) | 0.485 / 0.674 | 1024 | 38912 | 2166.0 | 260.21 |
| 152x38 | plain text | per window | 91.8 (82.8 to 95.1) | 1.723 / 2.880 | 166.6 (161.3 to 170.2) | 0.510 / 2.173 | 64 | 2432 | 135.4 | 16.27 |
| 152x38 | ANSI + truecolor | per chunk | 8.3 (8.2 to 8.3) | 1.135 / 1.716 | 13.4 (13.2 to 13.5) | 0.403 / 0.551 | 1024 | 38912 | 2166.0 | 203.47 |
| 152x38 | ANSI + truecolor | per window | 37.0 (36.4 to 38.0) | 1.148 / 1.518 | 42.3 (41.2 to 42.3) | 0.437 / 2.111 | 64 | 2432 | 135.4 | 12.72 |
| 152x38 | full-screen redraw | per chunk | 14.1 (13.9 to 14.1) | 0.729 / 0.964 | 22.9 (22.8 to 23.2) | 0.295 / 0.392 | 1024 | 24590 | 1368.8 | 131.04 |
| 152x38 | full-screen redraw | per window | 136.5 (134.5 to 143.7) | 0.732 / 1.429 | 172.6 (164.5 to 178.4) | 0.328 / 1.951 | 64 | 1550 | 86.3 | 8.25 |
| 152x38 | CJK/emoji/combining | per chunk | 7.2 (7.1 to 7.2) | 1.352 / 1.697 | 12.6 (12.4 to 12.6) | 0.426 / 0.640 | 1024 | 38912 | 2166.0 | 192.15 |
| 152x38 | CJK/emoji/combining | per window | 32.1 (31.0 to 32.3) | 1.374 / 1.725 | 36.1 (36.0 to 36.6) | 0.451 / 1.963 | 64 | 2432 | 135.4 | 12.01 |

**Full repaint of the Android Canvas harness's screens.** The harness above repaints a whole screen every frame, which the stream table does not (it draws dirty rows). To put the wgpu prototype next to the [Android Canvas replay](#android-canvas-drawing-of-the-shared-layout-waydroid-not-a-device) on the same frames, the bench also shows the 64 screens of each workload (80x24, 8x16 pixel cells, after every 256 KiB of the first 16 MiB, the screens `dump_layout` writes for the Canvas) as full frames, so every row is repainted every frame; 20 passes after a warm-up pass (the glyph atlas), draw plus present in milliseconds, p50 / p99, from the second run:

| workload | CPU reference | wgpu prototype | Android Canvas, tuned, software Bitmap (Waydroid) | Android Canvas, tuned, hardware frame total (Waydroid) |
|---|---|---|---|---|
| plain text | 0.812 / 1.373 | 0.312 / 0.580 | 0.687 / 0.925 | 1.194 / 1.883 |
| ANSI + truecolor | 0.446 / 0.832 | 0.259 / 0.573 | 0.188 / 0.304 | 0.663 / 1.693 |
| full-screen redraw | 0.466 / 0.913 | 0.241 / 0.548 | 0.535 / 0.608 | 1.095 / 1.621 |
| CJK/emoji/combining | 0.581 / 1.052 | 0.245 / 0.561 | 0.943 / 1.187 | 1.724 / 2.983 |

The three columns measure different things and the table is a way to see magnitudes side by side, not a ranking: the reference and wgpu figures are draw plus present on this process's own device (offscreen for wgpu, with dot-pattern glyphs and no font), the software Canvas figure is Skia on the CPU drawing real text through the system's monospace and fallback fonts, and the hardware Canvas figure is `FrameMetrics` `TOTAL_DURATION` of a window drawn through the Android pipeline (UI-thread recording, RenderThread command issue and GPU, from the intended vsync). All three ran on the same host and the same discrete GPU (Waydroid's guest uses it through GLES), at different times and load. With those caveats, every figure is far inside a 16.7 ms frame, the wgpu prototype was the cheapest on three of four workloads at the median and Skia on the CPU was cheaper on ANSI-heavy output (0.19 against 0.26 ms), which says that on this host the per-frame cost of any of them is small next to the pipeline above the renderer ([cost above the VT](#renderer-pipeline-cost-host-microbenchmark-not-a-candidate)), and nothing about a phone.

What this says, and does not say:

- **The wgpu frame was 1.6 to 3.6 times cheaper at the median** (0.25 to 0.51 ms against 0.45 to 1.72 ms for draw plus present), and the whole pipeline ran 1.0 to 2.2 times faster. The pipeline gain is small because most of a frame's cost is upstream of any renderer ([renderer pipeline cost](#renderer-pipeline-cost-host-microbenchmark-not-a-candidate)): at one frame per 256 KiB the style-heavy and Unicode workloads gained 4 to 14 % and plain text and redraws 12 to 82 %.
- **The tail was not better.** The wgpu p99 was higher than the reference's in 7 of the 16 rows, all at one frame per 256 KiB (1.7 to 2.1 ms against 0.7 to 1.7 ms), the cost of waiting on the GPU; over all rows it ranged from 0.36 to 2.17 ms against 0.67 to 2.88 ms. At 60 Hz a 16.7 ms frame budget holds all of these; a 120 Hz device has 8.3 ms and a phone GPU is slower than this one by an unknown factor.
- **Instances are much smaller than pixels**: the reference copies 6.5 to 11.3 times more bytes per run than the wgpu prototype uploads. Both counters are bytes handed to the presentation target, but they mean different things (pixel rows against instance data), so they say little about energy.
- **Memory is the cost to look at.** The first GPU context added about 61 MiB resident on this driver, against 7 to 8 MiB of renderer resident memory per background xterm.js session in the [renderer shootout](#renderer-shootout-xtermjs-renderers-1323); the 63 MiB is a Mesa driver on a desktop and is not an Android number. Four more renderers added about 3.1 MiB each (80x24).
- Not shown: any Android or mobile GPU (driver quality, Vulkan on Android, surface loss in practice), a window surface and compositor, presentation timing and tearing, idle wake-ups and energy, text (glyph rasterization, shaping, font fallback, atlas growth and eviction), selection and cursor behaviour with real fonts, binary size, and Metal or Direct3D 12. CI keeps this crate compiling (`cargo fmt --check` and `cargo clippy` in the `herdr-native` job) but has no GPU to run it, so the parity tests were run locally.

### wgpu on its OpenGL and OpenGL ES backends against Vulkan (same host GPU, not a device)

Measured with the unmodified `wgpu_bench` of the [prototype above](#wgpu-prototype-against-the-cpu-reference-renderer-host-gpu-not-a-device) ([#1323](https://github.com/mihazs/lazysh/issues/1323)), on one machine and one GPU through three wgpu backends: the question is what the OpenGL ES path costs next to Vulkan, which is the path a phone falls back to where Vulkan is missing or poor. No source changed. The prototype creates its wgpu instance with every backend allowed and the default run picks Vulkan, so the other two are selected from outside the process:

| Label | How it was selected | What wgpu reported (`adapter:` line of each raw file) |
| --- | --- | --- |
| Vulkan | nothing set | `backend: "Vulkan"`, `radv Mesa 26.2.6`, discrete GPU |
| GL 4.6 | `VK_DRIVER_FILES=/nonexistent`: the Vulkan loader finds no driver, so wgpu uses its GL backend | `backend: "Gl"`, `4.6 (Core Profile) Mesa 26.2.6`, radeonsi |
| GLES 3.2 | the same and `MESA_GL_VERSION_OVERRIDE=2.1`: Mesa refuses the desktop core context wgpu asks for first, so wgpu falls back to an OpenGL ES context | `backend: "Gl"`, `OpenGL ES 3.2 Mesa 26.2.6`, radeonsi |

Environment: AMD Radeon RX 5500 XT for all three (RADV for Vulkan, radeonsi for the other two), Mesa 26.2.6, wgpu 30.0.2, Linux 7.3.3, rustc 1.96.1 release profile, headless and offscreen (no display server, no window surface); the CPU is the Ryzen 9 5900X host of the other measurements, shared with other builds and agents (load average at the start of the six runs 9.6, 11.3, 12.0, 12.8, 17.0 and 25.0). Six runs of the whole bench in the order Vulkan, GL, GLES, GLES, GL, Vulkan, so that two runs per backend sit on both sides of a drifting load: raw outputs [Vulkan 1](benchmarks/terminal-wgpu-vulkan-bench-1.txt) and [6](benchmarks/terminal-wgpu-vulkan-bench-6.txt), [GL 2](benchmarks/terminal-wgpu-gl-bench-2.txt) and [5](benchmarks/terminal-wgpu-gl-bench-5.txt), [GLES 3](benchmarks/terminal-wgpu-gles-bench-3.txt) and [4](benchmarks/terminal-wgpu-gles-bench-4.txt). Everything else is as in the [wgpu section](#wgpu-prototype-against-the-cpu-reference-renderer-host-gpu-not-a-device): 16 MiB per workload, 5 runs inside each invocation, 8x16 pixel cells, a frame after every 16 KiB chunk or every 256 KiB, draw plus present per frame.

**Correctness.** `cargo test --release --test vs_reference` (4 tests, the pixel-for-pixel comparison with the CPU reference renderer, including incremental frames, wide and combining clusters, cursor shapes, selection and recovery from a lost device) passed under all three settings. That test prints no adapter, so which backend it ran on is established by the bench: the same variables gave the adapter lines in the table above, and with no Vulkan driver the test cannot have used Vulkan.

Frame cost of the 16 stream rows, p50 (first run / second run of each backend, draw plus present in milliseconds), then p99:

| grid | workload | frame cadence | Vulkan p50 | GL 4.6 p50 | GLES 3.2 p50 | Vulkan p99 | GL 4.6 p99 | GLES 3.2 p99 |
|---|---|---|---|---|---|---|---|---|
| 80x24 | plain text | per chunk | 0.32 / 0.31 | 0.36 / 0.33 | 0.36 / 0.42 | 0.58 / 0.47 | 1.25 / 0.83 | 6.14 / 1.33 |
| 80x24 | plain text | per window | 0.31 / 0.33 | 0.37 / 0.34 | 0.56 / 0.35 | 2.13 / 2.82 | 3.28 / 2.87 | 6.43 / 2.96 |
| 80x24 | ANSI + truecolor | per chunk | 0.26 / 0.25 | 0.28 / 0.27 | 0.29 / 0.28 | 0.47 / 0.39 | 0.82 / 0.73 | 3.00 / 0.84 |
| 80x24 | ANSI + truecolor | per window | 0.31 / 0.31 | 0.32 / 0.32 | 0.31 / 0.32 | 1.82 / 1.90 | 2.47 / 2.72 | 2.41 / 2.40 |
| 80x24 | full-screen redraw | per chunk | 0.26 / 0.26 | 0.27 / 0.33 | 0.26 / 0.26 | 0.53 / 0.48 | 0.79 / 1.15 | 0.40 / 0.50 |
| 80x24 | full-screen redraw | per window | 0.31 / 0.27 | 0.30 / 0.31 | 0.29 / 0.28 | 1.96 / 1.73 | 2.48 / 2.79 | 2.56 / 2.46 |
| 80x24 | CJK/emoji/combining | per chunk | 0.28 / 0.28 | 0.28 / 0.28 | 0.27 / 0.27 | 0.52 / 0.54 | 0.68 / 0.58 | 0.64 / 0.75 |
| 80x24 | CJK/emoji/combining | per window | 0.34 / 0.34 | 0.38 / 0.33 | 0.34 / 0.30 | 2.02 / 1.83 | 2.91 / 2.78 | 2.56 / 2.63 |
| 152x38 | plain text | per chunk | 0.50 / 0.51 | 0.71 / 0.71 | 0.71 / 0.54 | 0.95 / 0.94 | 2.37 / 3.94 | 1.81 / 0.80 |
| 152x38 | plain text | per window | 0.52 / 0.53 | 0.56 / 0.58 | 0.67 / 0.58 | 2.27 / 2.27 | 3.05 / 3.15 | 3.26 / 3.06 |
| 152x38 | ANSI + truecolor | per chunk | 0.40 / 0.42 | 0.52 / 0.56 | 0.48 / 0.49 | 0.68 / 0.85 | 1.43 / 1.75 | 1.01 / 1.61 |
| 152x38 | ANSI + truecolor | per window | 0.45 / 0.46 | 0.67 / 0.79 | 1.50 / 0.54 | 1.97 / 1.99 | 3.46 / 7.61 | 18.11 / 3.02 |
| 152x38 | full-screen redraw | per chunk | 0.30 / 0.30 | 0.44 / 0.44 | 0.33 / 0.34 | 0.49 / 0.46 | 1.93 / 2.58 | 0.57 / 0.60 |
| 152x38 | full-screen redraw | per window | 0.33 / 0.33 | 0.46 / 0.45 | 0.36 / 0.36 | 2.08 / 1.89 | 2.92 / 3.62 | 2.77 / 2.75 |
| 152x38 | CJK/emoji/combining | per chunk | 0.43 / 0.43 | 0.52 / 0.56 | 0.47 / 0.49 | 0.76 / 0.64 | 1.24 / 1.55 | 0.95 / 1.29 |
| 152x38 | CJK/emoji/combining | per window | 0.47 / 0.53 | 0.64 / 0.53 | 0.70 / 0.51 | 1.96 / 2.94 | 3.12 / 3.00 | 3.14 / 2.78 |

Full repaint of the 64 screens of each workload (80x24, 20 passes after a warm-up pass), draw plus present p50 / p99 in milliseconds, first run then second run of each backend; the CPU reference column is the range of its p50 over all six runs and is the control: it ran in the same process and was constant to within 5 % in 12 of the 20 rows (stream and repaint) and moved by 6 to 76 % in the other 8, which are the rows a loaded host disturbed:

| workload | CPU reference | Vulkan | GL 4.6 | GLES 3.2 |
|---|---|---|---|---|
| plain text | 0.802 to 1.195 | 0.370 / 1.212 ; 0.298 / 0.806 | 0.331 / 0.642 ; 0.316 / 0.485 | 0.328 / 0.800 ; 0.323 / 0.586 |
| ANSI + truecolor | 0.440 to 0.444 | 0.280 / 1.636 ; 0.227 / 0.385 | 0.243 / 0.361 ; 0.250 / 0.535 | 0.256 / 0.524 ; 0.245 / 0.470 |
| full-screen redraw | 0.453 to 0.651 | 0.272 / 2.115 ; 0.222 / 0.310 | 0.248 / 0.368 ; 0.255 / 0.504 | 0.249 / 0.345 ; 0.251 / 0.431 |
| CJK/emoji/combining | 0.573 to 0.581 | 0.252 / 0.476 ; 0.233 / 0.523 | 0.254 / 0.607 ; 0.258 / 0.746 | 0.251 / 0.353 ; 0.273 / 0.861 |

What this says, and does not say:

- **At the phone-sized grid the three backends cost the same per frame.** At 80x24 the median p50 of GL was 1.07 times Vulkan's (range 1.00 to 1.14 over the 8 rows) and GLES's 1.00 times (0.95 to 1.42); the full repaints were 0.97 to 1.08 times. The medians are 0.25 to 0.56 ms for the stream rows and 0.22 to 0.37 ms for the repaints, far inside a 16.7 ms frame, and the differences are of the size of the host noise (the reference control moved by up to 76 % between runs in some rows), so no ranking of the three can be drawn from them.
- **A larger grid is dearer through GL.** At 152x38 the median p50 was 1.36 times Vulkan's for GL 4.6 (1.09 to 1.60) and 1.19 times for GLES 3.2 (1.11 to 2.25). The 2.25 is one cell, 152x38 ANSI per window, where one GLES run measured 1.50 ms and the other 0.54 ms; the first was taken at load average 12.8 and its CPU reference was also slower in that cell (1.30 ms against 1.17 and 1.19 ms in the Vulkan runs), so that cell says little.
- **The tail was worse than Vulkan's.** The p99 of GL was higher than Vulkan's in 16 of 16 rows (median 1.7 times, up to 4.7) and GLES's in 15 of 16 (median 1.4 times, up to 7.1). The worst of the 120 p99 cells of the six runs was 18.1 ms (GLES 3.2, 152x38 ANSI, one frame per 256 KiB, in the run taken at load average 12.8; the same cell of the other GLES run was 3.0 ms); every other cell was 7.6 ms or less (GL 4.6 peaked at 7.6 ms in the same row), and the Vulkan runs peaked at 2.9 ms.
- **Pipeline throughput through GL was about as good as through Vulkan at 80x24 and lower at 152x38**: the median ratio of MiB/s was 0.96 (GL) and 1.01 (GLES) at 80x24 and 0.74 and 0.88 at 152x38 (rows 0.61 to 1.12). It includes the VT and the host load, so it is the weakest of these figures.
- **Memory was within a few MiB.** The first GPU context added 65.5 and 65.7 MiB resident (GL 4.6), 65.3 and 65.3 MiB (GLES 3.2) and 61.1 and 60.5 MiB (Vulkan); four more renderers added 10.7 and 10.7 MiB (GL), 10.6 and 10.6 MiB (GLES) and 12.6 and 12.6 MiB (Vulkan). Creating the first renderer took 175 and 40 ms (GL), 179 and 84 ms (GLES) and 234 and 243 ms (Vulkan); one invocation each says little about startup, but no backend was slower to start than Vulkan in these runs.
- **Not shown, and what it does not tell about an Android device.** The GLES context here is Mesa's radeonsi on a desktop GPU, forced by an environment variable, so these figures say that wgpu's GL backend adds no large cost next to Vulkan on one desktop driver and give nothing on an Android GLES driver (Adreno, Mali, PowerVR, ANGLE), whose quality, shader compiler and context-loss behaviour differ. Also not shown: wgpu on Android at all (the vendored `ghostty-vt` build has no Android target, see [Amendment 2](adr-0001-terminal-runtime.md#amendment-2-2026-11-13-native-candidates-measured-on-the-host-and-on-waydroid)), a window surface and EGL display on a device, presentation timing, energy, text, and idle wake-ups. The host load differed between runs (9.6 to 25), so a ratio below about 1.1 cannot be told from noise.

### wgpu renderer: idle, atlas and memory (host GPU, not a device)

Measured with `cargo run --release --example renderer_stats` and `--example wgpu_bench` in [`packages/terminal-renderer-wgpu`](../../packages/terminal-renderer-wgpu/README.md) ([#1324](https://github.com/mihazs/lazysh/issues/1324)): the production crate, which keeps the prototype's instanced-quad pipeline and adds a bounded glyph atlas with eviction, dirty-row batching (backgrounds merged into runs, the theme background dropped), `needs_draw()`, an adapter policy and counters. Still **offscreen and headless** with the reference renderer's dot-pattern glyphs: no window, swapchain, fonts or shaping (#1325), no Android, and a frame is still draw plus a wait for the GPU. Raw output: [`renderer_stats`](benchmarks/terminal-wgpu-renderer-stats-1.txt), [`wgpu_bench`](benchmarks/terminal-wgpu-renderer-bench-1.txt).

Environment: AMD Radeon RX 5500 XT (RADV NAVI14, Mesa 26.2.6), Vulkan, wgpu 30.0.2, discrete GPU; AMD Ryzen 9 5900X host shared with other builds and agents (load average 6.2 at the start of `renderer_stats`, 5.5 at the start of `wgpu_bench`); Linux 7.3.3, rustc 1.96.1 release profile; one run of each, no repeats beyond the bench's own 5 runs per cell.

**What a frame submits.** The same 16 MiB streams as above, a frame after every 256 KiB (64 frames), 8x16 pixel cells, 2048-texel atlas:

| grid | workload | rows drawn | passes (= submissions) | layout draws | instances submitted | glyph hits | glyph misses | atlas upload KiB | evictions | uploaded MiB |
|---|---|---|---|---|---|---|---|---|---|---|
| 80x24 | plain text | 1536 | 64 | 223,601 | 102,297 (46 %) | 100,685 | 36 | 4.5 | 0 | 3.13 |
| 80x24 | ANSI + truecolor | 1533 | 64 | 150,647 | 31,051 (21 %) | 27,986 | 21 | 2.6 | 0 | 0.95 |
| 80x24 | full-screen redraw | 150 | 64 | 15,243 | 3,433 (23 %) | 3,222 | 21 | 2.6 | 0 | 0.11 |
| 80x24 | CJK/emoji/combining | 87 | 64 | 7,265 | 1,294 (18 %) | 1,139 | 28 | 5.6 | 0 | 0.04 |
| 152x38 | plain text | 2432 | 64 | 530,417 | 163,211 (31 %) | 160,717 | 36 | 4.5 | 0 | 4.99 |
| 152x38 | ANSI + truecolor | 2429 | 64 | 413,833 | 49,443 (12 %) | 44,604 | 21 | 2.6 | 0 | 1.51 |
| 152x38 | full-screen redraw | 164 | 64 | 28,171 | 3,433 (12 %) | 3,222 | 21 | 2.6 | 0 | 0.11 |
| 152x38 | CJK/emoji/combining | 101 | 64 | 15,783 | 1,602 (10 %) | 1,447 | 28 | 5.6 | 0 | 0.05 |

Each frame is one pass and one `Queue::submit`. The renderer submitted 10 to 46 % of the draws the layout asked for, because a row is cleared to the theme background in one instance, the cell backgrounds that equal it are not drawn and neighbouring cells of one color are merged. The atlas misses are the distinct (cluster, width, weight) combinations of the stream: at most 36, each rasterized and uploaded once (a mask is one cell or two cells of bytes, 5.6 KiB at most per workload); nothing was evicted at this size.

**Rows drawn changed since the earlier tables, for every renderer.** `Screen::apply` now marks a row dirty only when its cells differ from what the renderer holds, so an application that rewrites the same text (a TUI repainting its status bar) costs no redraw. The full-screen-redraw and CJK workloads rewrite mostly identical rows: 2,070 and 1,047 rows were drawn per 1,024 frames at 80x24 where 24,576 were before (the [prototype table](#wgpu-prototype-against-the-cpu-reference-renderer-host-gpu-not-a-device) above lists the pre-change counts, and its frame times for those workloads are not comparable with these). The `wgpu_bench` run, one per-cell median of 5 runs ([raw output](benchmarks/terminal-wgpu-renderer-bench-1.txt)), draw plus present per frame in milliseconds, p50:

| grid | workload | CPU reference | wgpu | wgpu p99 against the reference's |
|---|---|---|---|---|
| 80x24 | plain text | 0.80 | 0.38 (2.1 times cheaper) | 1.7 against 1.4 ms (per chunk) |
| 80x24 | ANSI + truecolor | 0.44 | 0.23 (2.0 times) | 0.27 against 0.76 ms |
| 80x24 | full-screen redraw | 0.04 | 0.12 (**3.2 times dearer**) | 0.15 against 0.05 ms |
| 80x24 | CJK/emoji/combining | 0.02 | 0.13 (**6 times dearer**) | 0.15 against 0.03 ms |
| 152x38 | plain text | 1.70 | 0.41 (4.2 times cheaper) | 0.46 against 1.8 ms |
| 152x38 | ANSI + truecolor | 1.13 | 0.31 (3.6 times) | 0.38 against 1.2 ms |
| 152x38 | full-screen redraw | 0.06 | 0.13 (2.1 times dearer) | 0.16 against 0.07 ms |
| 152x38 | CJK/emoji/combining | 0.03 | 0.13 (4 times dearer) | 0.18 against 0.05 ms |

(One frame per 16 KiB chunk; the per-256 KiB cadence is in the raw file and says the same, with a wgpu p99 of 1.7 to 2.8 ms against 0.6 to 2.1 ms, which is the cost of waiting on the GPU.) **Where a screen changes by two rows, the reference renderer's frame (0.02 to 0.06 ms) is cheaper than the wgpu frame (0.12 to 0.16 ms)**: wgpu pays a fixed cost to submit and wait for the GPU that buys nothing when almost nothing is drawn. Where whole screens change it is 2 to 4 times cheaper. Full repaint of the 64 screens that the Android Canvas harness uses (every frame sets the appearance again, which marks every row stale; 80x24, 20 passes after a warm-up pass), p50 / p99 in milliseconds:

| workload | CPU reference | wgpu |
|---|---|---|
| plain text | 0.922 / 0.979 | 0.250 / 0.339 |
| ANSI + truecolor | 0.561 / 0.631 | 0.187 / 0.205 |
| full-screen redraw | 0.574 / 0.593 | 0.184 / 0.251 |
| CJK/emoji/combining | 0.693 / 0.731 | 0.186 / 0.204 |

The first `wgpu_bench` run of this crate was discarded: its full-repaint table redrew only the rows that differed between consecutive screens (identical rows are no longer redrawn), so for the redraw and CJK screens it measured almost nothing; the table above resets the appearance before every frame to mark every row stale. Its per-stream rows agreed with this run within about 30 % (plain text at 80x24: 0.29 against 0.38 ms for wgpu, 0.81 against 0.80 ms for the reference). This ranks nothing on any phone; it says that a GPU's fixed per-frame cost matters most exactly where the screen changes least.

**Idle.** 100,000 consecutive `draw` and `present` calls on a screen nothing changed: 0 submissions, 0 passes, 0 frames drawn or presented, 2 context switches of the process in total, 83 ns per call (a first run: 1 switch, 50 ns). The renderer starts no thread and no timer of its own, so there is nothing for it to wake; `needs_draw()` was false before every call (the example asserts it). This is the acceptance criterion "zero frames submitted while the screen is unchanged" for a steady cursor; cursor blink timing is #1326. Rewriting the same text (`tests/frames.rs`, 50 rewrites of a status line through the real core) also submitted nothing.

**GPU memory the renderer created** (its own buffers and textures, by construction; the driver's own scratch and the Vulkan driver's 62 MiB of process memory are not in it): 5,120 KiB at 80x24 (4,096 atlas, 960 target, 64 instance buffer), 7,048 KiB at 152x38 and 16,160 KiB at 300x80. The atlas is a fixed 4 MiB at the default size and the target grows with the window; the instance buffer grows by doubling up to a cap of 2 MiB (65,536 instances), so there is an upper bound that does not depend on the screen's content.

**Churn.** 20 warm-up frames, then 4,000 frames of 60 clusters never seen before (3x the atlas at the smallest size), on an 80x24 grid:

| atlas side | slots | renderer memory before / after (bytes) | live buffers before / after | resident set of the process after 20, 1,020, 2,020, 3,020 and 4,020 frames (KiB) | evictions | spills | passes |
|---|---|---|---|---|---|---|---|
| 64 | 28 | 1,019,920 / 1,019,920 | 5 / 5 | 85,664, 102,832, 105,932, 107,064, 107,320 | 3,030,476 | 684,838 | 688,858 |
| 512 | 1,792 | 1,277,968 / 1,310,736 | 5 / 5 | 103,576, 104,848, 106,116, 107,248, 107,320 | 26,263 | 0 | 4,020 |
| 2048 | 28,672 | 5,210,128 / 5,242,896 | 5 / 5 | 103,576, 104,848, 106,116, 107,248, 107,320 | 22,281 | 0 | 4,020 |

The 28-slot atlas turned over 3 million glyphs without growing (the renderer's memory is identical before and after, as is the driver's buffer count; it needs 171 passes per frame to do it, which is the price of an atlas far smaller than a screen, and why the default is large). The two larger sizes grew by one 32 KiB step of the instance buffer (it doubled once for a larger frame). The resident set rose by 1 to 2 MiB per 1,000 frames and flattened by 4,000 on every size, including the one that never evicts, so it is the core's scrollback filling (this harness writes 4,000 distinct lines), not the GPU side; a separate probe of 8,000 frames showed the 512-texel atlas's resident set flat from frame 4,000 to frame 8,000 (73.4 MiB). The test that guards this ([`memory_has_an_upper_bound_under_glyph_churn`](../../packages/terminal-renderer-wgpu/tests/frames.rs)) compares the renderer's own memory and the driver's live buffer count before and after 400 frames.

**Startup.** The first renderer took 59 ms to create and added 64,176 KiB to the resident set (the Vulkan driver and shader compiler), four more 17,468 KiB together (4.4 MiB each at 80x24, where the prototype run showed 3.1 MiB; one run each, from the `wgpu_bench` run above).

What this says, and does not say:

- **Idle is free and the atlas is bounded**, both measured on the host's GPU through the Vulkan backend and, for the pixel and counter tests, also on Mesa's software OpenGL (llvmpipe) as a stand-in for CI's software adapter.
- **A frame costs 0.12 to 0.43 ms of draw plus GPU wait at the median** on this machine's discrete GPU (80x24 and 152x38), and the GPU's fixed cost makes it slower than the CPU reference on screens where only a few rows change. Nothing here shows what a phone GPU's fixed cost is.
- **The first GPU context still costs 64 MiB of resident memory** on this driver against 7 to 8 MiB for an xterm.js session; the renderer's own GPU memory (5 to 16 MiB by window size) is small next to it.
- Not shown: any text (rasterization, shaping, font fallback and their atlas pressure: real glyph masks are larger and more varied than dot patterns), a window surface and presentation timing, Android (Vulkan or OpenGL ES drivers, surface loss), Apple, Windows, energy and thermals, a long-lived session's memory beyond 4,000 frames, and a CI run on real hardware (CI has only software adapters).

### Cursor blink, display scale and device loss (host GPU, not a device)

Measured with `cargo run --release --example renderer_stats` in [`packages/terminal-renderer-wgpu`](../../packages/terminal-renderer-wgpu/README.md) ([#1326](https://github.com/mihazs/lazysh/issues/1326)); raw output [`terminal-wgpu-renderer-stats-2.txt`](benchmarks/terminal-wgpu-renderer-stats-2.txt) (it repeats the tables of the section above, from a second run, then adds these two). Same host and offscreen, dot-pattern setup as above (load average 6.5 at the start); one run.

**Blink wakeups.** The host's single timer over real time, 10 s, three sessions of 80x24 sharing one `BlinkClock` (half period 530 ms): sleep to the instant `next_wake` names, set the phase on every session, draw and present.

| cursor | timer wakeups | per second | submissions per session | rows drawn per session | context switches of the process | wake lateness p50 / max |
|---|---|---|---|---|---|---|
| blinking block | 18 | 1.80 | 18 | 18 | 91 | 60 / 64 microseconds |
| steady block | 0 | 0 | 0 | 0 | 1 | no timer armed |

A blinking cursor cost one wakeup per phase change (18 in 10 s: the phase changes at 0.53, 1.06, ... 9.54 s) however many sessions share the timer, and in every session one row, one pass and one submission per wakeup. A steady cursor armed no timer, drew nothing and the process made one context switch in the 10 s. **The GPU does not stay awake with blink off.** The 91 switches with blink on are three sessions each waiting for its GPU work to finish at every phase (`present` waits), not a polling loop. This measures the timer and the renderer, not an Android `Handler` or a display's vsync, and not energy.

**Device loss.** 20 forced losses of an 80x24 renderer showing 24 rows of text, each recovered from the core's snapshot, in milliseconds: `resume` (a new device, pipeline and resources) p50 20.4 (min 20.0, max 22.1); resume plus snapshot plus draw plus present p50 22.1 (min 21.7, max 23.9). The picture after every recovery was the uninterrupted one (`tests/lifecycle.rs`: five losses compared with the reference renderer, identical pixels, the driver's live buffers and textures equal to those of a fresh renderer; the test bounds recovery at 5 s because it runs a debug build beside nine other tests, where five recoveries took 154 ms at worst). What was simulated is `Device::destroy()` on a desktop GPU: a driver reset on a phone, a surface lost with its window (#1327), memory pressure and a GPU that comes back slower were not.

**Display scale.** Not a timing: the renderer at 1x, 2x, 3x, 1.5x, 1.25x and back, switched by `set_appearance` and `resize` on the held screen (no snapshot), drew the reference renderer's pixels at every scale and the pixels of a renderer created at that scale; goldens at 2x and 3x are in the runtime crate. Refresh rate: one second of continuous output (a burst every millisecond) cost 60, 120 and 90 frames (within 2) on a 60, 120 and 90 Hz pacer, one submission each, and none once the output stopped.

### Text: real fonts in the wgpu renderer (host GPU, not a device)

Measured with `cargo run --release --example text_stats` in [`packages/terminal-renderer-wgpu`](../../packages/terminal-renderer-wgpu/README.md) ([#1325](https://github.com/mihazs/lazysh/issues/1325)); raw output [`terminal-wgpu-text-stats-1.txt`](benchmarks/terminal-wgpu-text-stats-1.txt). Same host as the sections above (AMD Radeon RX 5500 XT through RADV, Vulkan, wgpu 30.0.2, Ryzen 9 5900X shared with other agents, load average 3.2 at the start), offscreen, 80x24 cells of 16x32 pixels (display scale 2), one run. The fonts are the **subsets** of the test fixtures ([`tests/fonts`](../../packages/terminal-renderer-wgpu/tests/fonts/README.md)): what they lack (most CJK and emoji of the unicode workload) draws the missing-glyph box, which costs the same rasterization but is not a full CJK or emoji font. Each stream is drawn twice: `dots` is the layout's reference glyph, `fonts` the text path.

| workload | glyphs | glyph hits | glyph misses | hit rate % | atlas upload KiB | text ms total | us per miss | us per frame (64 frames) | wall ms per frame |
|---|---|---|---|---|---|---|---|---|---|
| plain text | dots | 100685 | 36 | 99.96 | 18.0 | 0.00 | 0.0 | 0.0 | 1.092 |
| plain text | fonts | 100685 | 36 | 99.96 | 18.0 | 0.21 | 5.8 | 3.3 | 1.151 |
| ANSI + truecolor | dots | 27986 | 21 | 99.93 | 10.5 | 0.00 | 0.0 | 0.0 | 4.008 |
| ANSI + truecolor | fonts | 27986 | 21 | 99.93 | 10.5 | 0.14 | 6.8 | 2.2 | 4.169 |
| full-screen redraw | dots | 3222 | 21 | 99.35 | 10.5 | 0.00 | 0.0 | 0.0 | 1.168 |
| full-screen redraw | fonts | 3222 | 21 | 99.35 | 10.5 | 0.14 | 6.7 | 2.2 | 1.030 |
| CJK/emoji/combining | dots | 1139 | 28 | 97.60 | 22.5 | 0.00 | 0.0 | 0.0 | 4.051 |
| CJK/emoji/combining | fonts | 1139 | 28 | 97.60 | 40.5 | 2.23 | 79.6 | 34.8 | 4.014 |

The glyph cache hit rate with fonts is the atlas's: it is the same as with dots because a cluster is rasterized once while resident, whatever draws it. Shaping and rasterizing a cluster that missed cost 5.8 to 6.8 microseconds for Latin and 79.6 on average for the unicode stream (wide clusters, color bitmaps, marks), so a frame that meets a screenful of new characters pays a few milliseconds once and the next frames pay nothing for text work: the steady frames of the first three streams spent 2.2 to 3.3 microseconds each shaping and rasterizing (`text ms` counts the misses only; the face lookup every glyph pays, hit or miss, is in the wall time). Cold start (a library of five faces, a renderer, one frame of 37 distinct glyphs): 15.62 ms to build the library and renderer, 3.24 ms for the first frame of which 0.24 ms was shaping and rasterizing. The wall time per frame is the benchmark's own feeding and drawing loop: plain text 1.092 then 1.151 ms, ANSI 4.008 then 4.169, redraw 1.168 then 1.030, unicode 4.051 then 4.014 ms (dots then fonts); one run on a shared host, so differences of that size are not established (the first run of the same example, before a per-glyph allocation was removed from the face lookup, read 1.182, 4.099, 1.166 and 4.130 ms for dots and 1.274, 4.075, 1.172 and 4.314 for fonts), and none of it says what fonts cost on a phone. The atlas upload of the unicode stream grew from 22.5 to 40.5 KiB because color glyphs are four bytes a texel.

**Shaping library.** `swash` 0.2 (shaping with GSUB and GPOS, unhinted outlines, CBDT, sbix and COLR). It is pure Rust, so the Android and Apple builds need no C toolchain beyond what wgpu already has, and one dependency does what the issue asks of three. Cost measured on a scratch crate that shapes one cluster and renders one glyph ([`terminal-wgpu-text-size-1.txt`](benchmarks/terminal-wgpu-text-size-1.txt)): **0.89 MiB** of stripped binary (opt-level `s`, LTO, x86_64 Linux) over a program that only reads the font. The same crate compiled for `aarch64-linux-android` and `x86_64-linux-android` (`cargo check`, no NDK needed); the 32-bit Android targets are not installed here and were not checked, and nothing ran on a device. Not measured: a rustybuzz or HarfBuzz stack with a separate rasterizer, which was the alternative; the choice rests on the C-free build and one dependency, not on a size comparison.

**Fonts of the machine.** `FontLibrary::system` for the list `SFMono-Regular, Liberation Mono, monospace` on the same host (895 files below `/usr/share/fonts` and `~/.local/share/fonts`): 436 ms in a debug build, one run, most of it reading the families it chose into memory (a CJK collection among them); it found Liberation Mono, a monospace font, Noto Sans Mono CJK SC and Noto Color Emoji. It runs once per surface and once per change of the font list, on the session's renderer thread. Not measured: a release build, a cold file cache, and Android's `/system/fonts`.

### Android Canvas drawing of the shared layout (Waydroid, not a device)

Measured with the harness in `apps/client/bench/android-canvas` ([#1323](https://github.com/mihazs/lazysh/issues/1323)): a throwaway APK (no Gradle, built by `build.sh` from the Android SDK command-line tools; it is not part of the app and not built by CI) that replays the shared layout of [`layout::row_draws`](native-rendering.md#terminal-renderer-api) with the Android `Canvas` API. The layouts are frames of draws written by `cargo run --release --example dump_layout -- <dir>` (packages/terminal-runtime): the 80x24 screen of each benchmark workload after every 256 KiB of its first 16 MiB (64 frames), 8x16 pixel cells, so the Canvas candidate draws exactly what the CPU reference renderer and the wgpu prototype draw. This is the "native drawing (Skia, Android Canvas)" candidate: the Android Canvas is Skia, so no separate Skia build was made; desktop Skia was not built.

Two paths per workload and two replays. **Software**: the frame is drawn onto a `Bitmap`-backed `Canvas` (Skia on the CPU), wall time of the replay, 3000 frames after 300 warm-up frames. **Hardware**: a full-window `View` invalidated once per `Choreographer` frame, 900 frames with the first 30 dropped, and the per-frame durations the platform reports through `FrameMetrics` (`onDraw` and `DRAW_DURATION` record the display list on the UI thread, `COMMAND_ISSUE_DURATION` is the RenderThread issuing GL commands, `GPU_DURATION` the GPU, `TOTAL_DURATION` from the intended vsync to completion). **As-is** issues one Canvas call per draw of the layout. **Tuned** does what a Canvas terminal does: clears to the theme background, fills only non-default backgrounds with contiguous cells of one color merged, draws runs of ASCII glyphs of one color and weight as a single `drawText` (the paint is scaled so a monospace advance equals the cell width), and draws every other glyph, including wide, combining and emoji clusters, one cell at a time, then the decorations.

Environment: Waydroid ("WayDroid x86_64 Device", Android 13, SDK 33, x86_64 LineageOS guest) on the host of the other measurements (AMD Ryzen 9 5900X, Linux 7.3.3, shared with other builds and agents; the load average was not recorded for this run). The guest's GLES renderer is the host GPU, `AMD Radeon Graphics (radeonsi, navi14, ACO)`, Mesa 26.0.8, OpenGL ES 3.2; the guest reports a 1920x1017 window at a 240 Hz refresh. Fonts are the system monospace family and the system's fallback for everything else, not the app's fonts. One run, no repeats ([raw output](benchmarks/terminal-android-canvas-bench-1.txt), the logcat lines of the harness); the figures are medians, with p99 where shown. Three more runs were attempted at host load averages of 13 to 34 and none is used. The first two showed a harness bug: it started a new run on every `onResume` (waking the screen was enough), so two or three runs overlapped and interleaved in the log, and one failed with "only 0 frames measured". The harness now starts one run per process (`STARTED`), and in the next attempt a second resume logged "run already started: true" and no second worker thread ran. That attempt was then interrupted: the activity was paused and resumed 43 s into the run, by something on the shared guest that was not identified, and the run failed with the same "only 0 frames measured" instead of reporting a number. The recorded run is therefore the only valid one; it has one worker thread and exactly one row per case in its log.

To run it: dump the layouts (`cargo run --release --example dump_layout -- <dir>/layouts`, from a build root laid out as in the crate README), build with `apps/client/bench/android-canvas/build.sh <sdk> <jdk> canvasbench.apk <dir>` (`<dir>` holds `layouts/`; the key is generated per build, so uninstall `app.lazysh.canvasbench` before installing a new build), install with `adb install -t`, start `app.lazysh.canvasbench/.BenchActivity` with the screen on and read `adb logcat -s LazyshCanvasBench`. The software run fails if the bitmap stays blank and the tuned-versus-as-is comparison fails if nothing was painted; uninstall the package afterwards.

Frame cost in milliseconds (the draw count is that of the first frame; Canvas calls are the average over the frames):

| workload | replay | draws in layout | Canvas calls per frame | software Bitmap canvas p50 / p99 ms | hardware: record (`onDraw`) p50 ms | hardware: command issue p50 ms | hardware: GPU p50 ms | hardware: frame total p50 / p99 ms |
|---|---|---|---|---|---|---|---|---|
| ANSI + truecolor | as-is | 2328 | 2357 | 1.303 / 1.661 | 0.582 | 1.503 | 0.323 | 2.601 / 4.342 |
| ANSI + truecolor | tuned | 2328 | 71 | 0.188 / 0.304 | 0.112 | 0.179 | 0.266 | 0.663 / 1.693 |
| CJK/emoji/combining | as-is | 2127 | 2128 | 1.426 / 1.622 | 0.654 | 1.620 | 0.403 | 2.791 / 3.729 |
| CJK/emoji/combining | tuned | 2127 | 518 | 0.943 / 1.187 | 0.572 | 0.691 | 0.289 | 1.724 / 2.983 |
| full-screen redraw | as-is | 2439 | 2439 | 1.440 / 1.790 | 0.818 | 2.023 | 0.535 | 3.500 / 5.224 |
| full-screen redraw | tuned | 2439 | 289 | 0.535 / 0.608 | 0.331 | 0.396 | 0.273 | 1.095 / 1.621 |
| plain text | as-is | 3485 | 3493 | 3.196 / 3.922 | 1.779 | 2.726 | 0.319 | 5.051 / 8.088 |
| plain text | tuned | 3485 | 308 | 0.687 / 0.925 | 0.381 | 0.434 | 0.281 | 1.194 / 1.883 |

Pixel difference of the tuned replay from the as-is one over eight frames: 0.000 % of all pixels for plain text and ANSI, 0.094 % (0.72 % of the non-black pixels) for CJK/emoji/combining and 0.269 % (2.17 %) for the full-screen redraw. The likely cause is draw order rather than text positioning (the tuned replay draws all text after all backgrounds, so a glyph that overhangs its cell is no longer covered by the next cell's background); it was not isolated.

What this says, and does not say:

- **Every frame fit in a 16.7 ms frame**: none of the 870 hardware frames per case took longer than 10.0 ms (that maximum is plain text, as-is; the other maxima are 2.4 to 6.3 ms). Plain text is the most expensive workload for the as-is replay (5.1 ms total at the median, 8.1 ms at p99) because it has the most glyphs.
- **The cost is the number of Canvas calls, not the GPU.** For plain text the as-is replay spent 1.8 ms recording and 2.7 ms issuing commands against 0.3 ms of GPU time; the tuned replay needs 308 calls instead of 3493 and a median total of 1.2 ms, 1.6 to 4.2 times faster across the workloads (the gain is smallest for CJK/emoji/combining, where most glyphs still go one at a time). The renderer design question on Android is therefore batching and caching display lists, not GPU throughput.
- **Wide, combining and emoji clusters cannot be batched**: each needs its own placement on the grid, which is also what keeps them from shifting the columns after them ([#1325](https://github.com/mihazs/lazysh/issues/1325)). They are a minority of cells in these fixtures and the whole of the CJK fixture's remaining cost.
- **Not comparable with the other renderers' tables.** Those draw the dirty rows of a live stream (the CPU reference renderer 0.4 to 1.6 ms per frame, the wgpu prototype 0.2 to 0.5 ms at the median, [wgpu table](#wgpu-prototype-against-the-cpu-reference-renderer-host-gpu-not-a-device)) with dot-pattern glyphs and no font; this table repaints the whole screen every frame through a real text stack with font fallback. The [wgpu section](#wgpu-prototype-against-the-cpu-reference-renderer-host-gpu-not-a-device) puts the full-repaint figures side by side; a like-for-like incremental Canvas figure needs per-row display lists, which were not built.
- Not shown: a physical Android device or any phone GPU (Waydroid's GPU is a desktop AMD part, so a phone's driver, memory bandwidth, thermal throttling and power are unmeasured), energy, the app's fonts and CJK fallback behaviour, shaping beyond what `Canvas.drawText` does, a `SurfaceView` with `lockHardwareCanvas` or a Vulkan surface (this is `View.onDraw`), compositing with the WebView, per-row display-list caching (the likely next optimization), and the Rust-to-Kotlin hop: the layouts are replayed from files because libghostty-vt does not build for Android yet ([#1312](https://github.com/mihazs/lazysh/issues/1312)).

### Mosh display update in the core (host microbenchmark, not a device baseline)

Measured with `cargo run --release --example mosh_bench` in `packages/terminal-runtime` ([#1317](https://github.com/mihazs/lazysh/issues/1317)). One update is the bytes of a Mosh display frame (`begin` envelope, `ESC [ r`, home, clear, a full repaint of every row with a colour per row, `end` envelope) fed in one call, a canonical resize when the grid size changes, and the first renderable frame taken. It is the core's share of resize-to-first-correct-frame: the Mosh transport, the JS bridge, the renderer and the display are not included, and there is no xterm.js comparison, so no ratio is valid. Same host and toolchain as the tables above (AMD Ryzen 9 5900X, Linux 7.3, rustc 1.96.1 release), taken while the host was heavily shared: the 1-minute load average at the start was 12.9 (24 threads). One invocation of 4000 updates per row; the figures are milliseconds per update.

| Grid sizes | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| 80x24, unchanged on every update (the usual case) | 0.165 | 0.333 | 0.392 | 4.800 |
| 80x24 and 40x12 alternating | 0.165 | 0.198 | 0.249 | 0.901 |
| 120x40 and 60x20 alternating | 0.531 | 0.687 | 0.958 | 1.590 |

The resize adds no measurable time over the repaint at 80x24 (the p50 is the same with and without it), and the cost follows the number of cells repainted. It says the core's share is a fraction of a frame on this host; it does not say what a phone costs, and a single invocation under load is not a regression threshold. An earlier invocation (load 17.3) gave p50 0.169 and 0.521 ms for the two alternating rows.

### Screen inspection in the core (host microbenchmark, not a device baseline)

Measured with `cargo run --release --example inspect_bench` in `packages/terminal-runtime` ([#1318](https://github.com/mihazs/lazysh/issues/1318)). A Herdr tap reads two things: row 0 and the right 10 columns of row 1; the second row is a screen read of every visible row, for scale. Core only: no bridge, no JavaScript, no device, so it is not the cost of a tap in the app and no ratio against xterm.js is valid. Same host and toolchain as the tables above (AMD Ryzen 9 5900X, Linux 7.3, rustc 1.96.1 release); the 1-minute load average at the start was 3.6. One invocation of 20,000 runs per row; microseconds per query.

| Grid | Query | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| 46x30 | Herdr tap (two reads) | 1.8 | 1.8 | 1.9 | 20.7 |
| 46x30 | every visible row | 26.7 | 26.9 | 33.5 | 109.0 |
| 80x24 | Herdr tap | 2.9 | 2.9 | 3.0 | 10.1 |
| 80x24 | every visible row | 32.3 | 32.4 | 37.3 | 82.2 |
| 200x60 | Herdr tap | 6.6 | 6.6 | 8.0 | 41.4 |
| 200x60 | every visible row | 168.6 | 174.2 | 180.2 | 350.1 |

The tap check costs a few microseconds here and scales with the row width (each read visits every column of the row to find the span), so the inspection itself is not where a tap's latency would come from; the bridge round trip, which this does not measure, is. It does not say what a phone costs.

### Selection and search on a large scrollback (host microbenchmark, not a device baseline)

Measured with `cargo run --release --example selection_bench` in `packages/terminal-runtime` ([#1320](https://github.com/mihazs/lazysh/issues/1320)): 80-column lines of 66 characters, the scrollback budget raised so every line is kept (the default is 4 MiB). Core only: no bridge, no JavaScript, no xterm.js comparison, no device, so no ratio is valid. Same host and toolchain as the tables above (AMD Ryzen 9 5900X, Linux 7.3, rustc 1.96.1 release), taken while the host was shared (1-minute load average 14.8 at the start, on 24 threads). One invocation, on 2026-11-19 at the commit of the link slice; the figures are milliseconds.

| Rows held | Text of everything (p50, max) | Search that misses (p50, max) | URL and path detection on one row (p50, max) | Word under a finger (p50) |
| --- | --- | --- | --- | --- |
| 5,001 (0.3 MiB of text) | 24.3, 25.6 | 8.5, 9.9 | 0.43, 2.27 | 0.001 |
| 20,001 (1.3 MiB of text) | 100.5, 107.5 | 34.2, 34.6 | 0.42, 0.83 | 0.001 |

Extraction and a missing search are linear in the rows read (about 5 microseconds a row for the text, 1.7 to 1.9 for the search); a word under a finger reads one row, and link detection reads the 33 rows around the tapped one (more only while a soft-wrapped line continues). An earlier invocation taken at load 22.8 gave 25.1 and 100.8 ms for the text and 8.2 and 33.1 ms for the search, and one at load 18.8 gave 24.1 and 100.7 ms for the text and 8.1 and 37.4 ms for the search. It does not say what a phone costs, and a single invocation under load is not a regression threshold.

### Build cost of the wgpu renderer as an app dependency (build host, not a device)

The app depends on [`packages/terminal-renderer-wgpu`](../../packages/terminal-renderer-wgpu/README.md) behind its optional `native-terminal` feature ([#2201](https://github.com/mihazs/lazysh/issues/2201)). Nothing in the app calls the renderer yet, so these figures are what the dependency costs a build with the feature on, not what a renderer in use will cost. Builds without the feature compile none of it. Raw output: [`benchmarks/terminal-renderer-app-dependency-build-1.txt`](benchmarks/terminal-renderer-app-dependency-build-1.txt). One run each on an AMD Ryzen 9 5900X shared with other work (load average 1 to 5), four Cargo jobs.

**Linux x86_64, measured.** `cargo build --release --locked --features native-terminal` of the app (rustc 1.99.0, the root release profile: LTO, one codegen unit, stripped), with the feature first without and then with the renderer dependency, twice:

| Artifact | Without the renderer | With the renderer | Delta |
| --- | --- | --- | --- |
| `lazysh` executable | 57,207,792 bytes | 57,205,872 bytes | -1,920 bytes |
| `liblazysh_lib.so` | 3,951,496 bytes | 3,951,496 bytes | 0 |
| `liblazysh_lib.a` | 404,486,146 bytes | 404,544,512 bytes | +58,366 bytes |

The sizes were identical in both runs of each state. The executable is not byte-identical and is 1.9 KiB smaller, because the dependency turns on features of crates the app already had (`bytemuck` derive, `zerocopy` derive, `num-traits` with `libm`, `hashbrown` 0.17.1 with its default hasher), which recompiles their dependents; no renderer code is linked.

A clean build without the renderer took 526 s. Adding it took 352 s in the same target directory, against 252 to 256 s for the app crate's own recompile and link alone, so about 98 s more: 62 CPU-seconds in the 29 crates the renderer adds on Linux (naga 18.5 s, wgpu-core 16.1 s, wgpu-hal 7.4 s, ash 6.6 s) and the one-off rebuild of 74 crates whose features changed.

**Android arm64 and x86_64, compile time measured, package size not measured.** The renderer and the crates it adds (wgpu with the Vulkan and OpenGL ES backends) compile and archive for both ABIs with NDK r29.0.14206865 in 26 s (aarch64) and 24 s (x86_64) on top of the runtime crate, in the renderer's own release profile (no LTO, rustc 1.96.1); the renderer's `rlib` is 0.45 MiB per ABI. No Android package was built with the feature here, so the size delta of the shipped `.so` is **not measured**; the Linux result (no renderer code linked while nothing calls it) is the only evidence for it. The delta that matters, with the renderer drawing on a surface, belongs to [#1327](https://github.com/mihazs/lazysh/issues/1327).

Not shown: macOS, iOS and Windows (their backends, Metal and Direct3D 12, were not compiled here; the root lock file pins their crates), a build on a CI runner, and any binary that calls the renderer.

## Acceptance of a candidate

A candidate may replace the fallback on a device only if, on that device, all of the following hold with the recorded environment: provisional targets from the [PRD](terminal-performance-prd.md#provisional-targets-not-measurements) are met or the improvement is otherwise justified in the ADR; no input-latency regression under heavy output; no correctness regression on the conformance fixtures; near-zero idle activity; stable memory across session churn.

## Regression benchmarks in CI

CI can only run what is reproducible on hosted runners: parse throughput of the core, per-session memory, golden-image comparisons and an injected-slowdown self-test. Device-only metrics follow a documented manual procedure and are not gated automatically ([#1341](https://github.com/mihazs/lazysh/issues/1341)).

The `terminal-perf` job of `checks.yml` runs `cargo run --release --example perf_gate` in `packages/terminal-runtime` against the same checksum-verified libghostty-vt build as the `herdr-native` job. It is a job of its own, alone on its runner, and it is not a required check: a regression or a noisy host can never skip the jobs that consume `herdr-native`'s binaries. It runs on every push to `main` and on a pull request that selects the terminal runtime area, so a regression shows on the pull request that causes it; it stays report-only until the maintainer makes it a required check in the repository ruleset ([CONTRIBUTING.md](../../CONTRIBUTING.md#which-ci-jobs-a-pull-request-runs)). A metric beyond its limit makes the example exit 1 and the job red; the table goes to the job summary.

What the gate holds, and the limit of each (the limits sit at a distance from the measured value that no run-to-run spread reached; "Measured" is the value, or the lowest to highest, of five invocations on the host below):

| Metric | Measured | Limit | Why this kind of metric |
| --- | --- | --- | --- |
| Scrollback rows kept, 80 columns, default 4 MiB budget | 5,280 | at least 5,200 | deterministic (it is the budget policy) |
| Resident memory per session after 8 MiB of 80-column lines, 5 and 10 sessions, attached | 3,920 to 3,922 KiB at both counts | at most 5,000 KiB | memory per session; the same in every invocation |
| Resident memory per session, 5 and 10 sessions detached and idle after compaction ([#1338](https://github.com/mihazs/lazysh/issues/1338)) | 617 to 620 KiB at 5, 454 to 455 KiB at 10 | at most 1,500 KiB | memory per session through the hub; the limit is a third of the filled figure, so a session that stops being compacted fails it |
| Resident growth over 80 create, feed 1 MiB and drop rounds, after 20 warm-up rounds | 0 KiB | at most 2,048 KiB | no growth over churn; the margin is for another allocator |
| Allocations per MiB, VT only, plain text | 128.6 | at most 142 | deterministic; two per 16 KiB chunk, so no allocation per byte or per cell on the parse path |
| Allocations per MiB, VT plus a frame per chunk, plain text | 247,305 | at most 260,000 | deterministic; this is the cost of `Frame` owning a `String` per cell |
| Reference renderer bytes uploaded per MiB of output, full-screen redraw, one frame per 256 KiB | 2.81 MiB | at most 2.87 MiB | deterministic; what dirty-row damage tracking is for |
| Frame cost, plain text: throughput with a frame per chunk over VT-only throughput | 0.119 to 0.129 | at least 0.05 | a ratio of two passes in one process |
| Frame cost, ANSI and truecolor, the same ratio | 0.606 to 0.642 | at least 0.40 | the same, where the parse dominates |
| VT-only throughput, plain text | 609 to 633 MiB/s | at least 100 MiB/s | an absolute floor for a collapse only |

Golden images are not part of this job: `cargo test --test renderer` compares the reference renderer's output with the committed images pixel for pixel inside `herdr-native` already, and a divergence fails that required job.

Noise handling, in order of preference:

1. **Counts that do not depend on the host** (allocations, rows kept, bytes uploaded, memory per session) carry tight limits. They were identical across five invocations at 1-minute load averages of 4.8 to 7.9 on 24 threads.
2. **Timed metrics are ratios of two passes in the same process.** The host's speed, clock and load affect both passes and cancel; only a change in the code under test moves the ratio. Each pass is the best of five, because noise only ever slows a pass down. A ratio below its limit is measured again, up to three batches of five passes with the bests carried over, before it fails.
3. **No absolute latency or throughput threshold finer than a floor.** The one absolute speed, 100 MiB/s for plain text, is about six times below the host measured here and catches a collapse only. Latency tails (the credit latency p99 and the input-to-write p99 of the session benchmark) moved by a factor of two between invocations on a shared host and are not gated.
4. **Limits sit well away from the measured value.** By arithmetic from the measured ratios, the two ratio limits trip at a frame path about 2.5 to 2.8 times slower than measured (the injected run below, a frame path four times slower, failed both), and the allocation limit at 5 percent more allocations. A gentler regression is not caught by this job; it shows in the benchmark tables above, which are run by hand.

Self-test: `perf_gate --inject slow` spins for three times the time of every `take_frame` call, `--inject allocs` makes every frame allocate once per cell it carries, and `--inject nocompaction` runs the idle sessions in a hub that never compacts. The job runs all three after the real gate and fails unless each exits with status 1 (a crash exits differently and does not count). On the host above the real gate took 2.8 s, `--inject slow` failed both ratio metrics (plain text 0.039 and ANSI 0.310 against 0.123 and 0.629 without injection, 13.3 s because failing ratios are re-measured) and `--inject allocs` failed the allocation metric (370,185 allocations per MiB against 247,305).

Environment of the figures above: AMD Ryzen 9 5900X (24 threads), Linux 7.3.3, rustc 1.96.1 release profile, libghostty-vt from the vendored Ghostty commit `44f2a44df` built with Zig 0.16.0 `ReleaseFast`, x86_64, 1-minute load average 4.8 to 7.9 during the five invocations. **Hosted `ubuntu-22.04` runner** (one run of this gate on a pull request, before the job was restricted to pushes to `main`: [run 43591350796](https://github.com/mihazs/lazysh/actions/runs/43591350796/job/132469854304), all nine metrics ok, job wall time 2 min 42 s including the Zig build): every count equal to the table above (5,280 rows, 3,922 KiB per session, 0 KiB growth, 128.6 and 247,305 allocations per MiB, 2.81 MiB uploaded), plain-text frame cost ratio 0.127 (limit 0.05), ANSI ratio 0.589 (limit 0.40, a narrower margin than on the desktop host, which measured 0.606 to 0.642) and VT-only throughput 589 MiB/s (floor 100). One hosted run is thin evidence for the timed ratios; the first runs on `main` add to it, and the limits change only with more figures in hand.

Not covered, by design: Android and iOS devices, the xterm.js baseline (its harness needs a browser and is not reproducible enough on a hosted runner for a threshold), the wgpu prototype (it needs a GPU), and any latency to the display. Device runs follow [the Android procedure](#android-procedure-manual-gate-not-run).

## Existing, unrelated measurements

`docs/android-startup-cpu-budget.md` measures emulator startup behaviour for SystemUI ANR sensitivity. It is not a terminal measurement and is not used as a baseline here.

## Unresolved questions

- Best method for input-to-presentation on Android without external hardware.
- How to hold radios and brightness constant across energy runs on the available devices.
- Whether hosted CI can produce stable enough numbers for any latency threshold. The `terminal-perf` gate avoids the question: it gates ratios inside one process and counts, and no latency. Whether its limits stay wide enough on a hosted runner is checked by its runs on `main`.
