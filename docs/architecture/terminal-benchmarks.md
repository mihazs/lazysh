# Terminal benchmarks

Status: **the xterm.js baseline and the xterm.js canvas and WebGL renderer addons are measured on one desktop host; nothing else is.** No Android, iOS, Windows or macOS device, no emulator and no native candidate (wgpu, Skia or Canvas drawing, a WASM terminal) has been built or measured. The measured rows below come from the harness described in [Baseline harness](#baseline-harness-xterm-js-dom-renderer), run in headless desktop Chromium, which is **not an Android WebView**. A number may be quoted elsewhere in `docs/architecture` only if it comes from this suite, with its environment block. Tracking: harness [#1303](https://github.com/mihazs/lazysh/issues/1303), renderer shootout [#1323](https://github.com/mihazs/lazysh/issues/1323), CI regression [#1341](https://github.com/mihazs/lazysh/issues/1341), Android energy [#1340](https://github.com/mihazs/lazysh/issues/1340). Related: [PRD](terminal-performance-prd.md) · [native rendering](native-rendering.md).

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
```

`bench:terminal` builds the benchmark page with `vite build -c vite.bench.config.ts` (minified, React production) and serves it with `vite preview`; the run is rejected if the page reports a non-production build. Output defaults to `apps/client/bench-results/terminal-baseline-<viewport>.json` (git-ignored). Results worth keeping are copied to [`benchmarks/`](benchmarks/).

To measure another renderer on the same terminal, fixtures and counters, set `LAZYSH_BENCH_RENDERER=canvas` or `webgl` (default `dom`) and, to choose the GL backend, `LAZYSH_BENCH_CHROMIUM_ARGS`. `bench/compare.ts` prints several result files side by side: `bun bench/compare.ts dom=a.json webgl=b.json`.

The same spec also runs in **smoke mode** inside the normal Playwright suite (`e2e/terminal-bench.spec.ts`, desktop project only, against the dev server). Smoke mode uses tiny fixtures and asserts only that every workload completes, ends on the expected screen, and reports finite numbers. It has **no timing thresholds**, so it cannot flake on a slow runner. The deterministic fixture generators and the statistics helpers have unit tests (`bench/workloads.test.ts`).

### What is simulated and what is real

| Stage | Real in the harness | Simulated or missing |
| --- | --- | --- |
| Bridge | `JSON.parse` of a `number[]` chunk and `new Uint8Array(...)`, the same decoding `SshEvent::Data` goes through, timed separately | The native IPC hop (Tauri channel, WebView message), which only a device or the real app can measure |
| Flow control | 16 KiB chunks and the 256 KiB credit window of the Rust session workers; the credit is returned in the xterm `write` callback, as `App.tsx` does | The per-chunk `ack_output` IPC round trip is not issued |
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

**Not implemented in this baseline:** W5 (vim/Neovim), W6 (tmux, Zellij), W7 (Mosh resize and reconnect; the frame fixture `apps/client/e2e/fixtures/mosh-resize-frames.json` exists but is not replayed here), W8 (agent streams), W11 (background, resume, surface recreation) and W13 (thermal). They need a real remote or a device and remain open on [#1303](https://github.com/mihazs/lazysh/issues/1303). **No Rust-side parse benchmark was added:** the baseline's VT parse runs in xterm.js, and the Rust workers only chunk bytes; a parse benchmark of the shared core belongs to [#1313](https://github.com/mihazs/lazysh/issues/1313) and [#1341](https://github.com/mihazs/lazysh/issues/1341).

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

Not shown: anything about Android, an Android WebView (which is Chromium, but its GPU, driver, memory pressure and context-loss behaviour are exactly what is unknown), the Linux desktop WebView (WebKitGTK, not Chromium), macOS or iOS (WKWebView), Windows (WebView2), energy, thermal behaviour, a WebGL context loss and recovery, background and resume (W11), accessibility with a canvas renderer, the phone viewport, W5 to W8 and W13. WebGL numbers here come from a discrete desktop GPU shared with other work; they do not transfer to a phone GPU.

### Android procedure (manual gate, not run)

The harness cannot run on Android in this form: it drives desktop Chromium over CDP. Until an Android runner exists ([#1303](https://github.com/mihazs/lazysh/issues/1303), [#1340](https://github.com/mihazs/lazysh/issues/1340)), the Android measurement is a manual gate with this procedure. **None of it has been executed;** the tools named are standard Android tooling and the steps have not been validated on a device for this app.

1. Fix the conditions and record them in the environment block: physical device (model, SoC, RAM, Android build, WebView version from `adb shell dumpsys webviewupdate`), release build of the app (`app.lazysh.client`), fixed brightness, airplane mode with Wi-Fi only (or a fixed radio), battery above 80 %, thermal state cool, screen kept awake, the same SSH host and the same replay fixture for each run.
2. Reset counters: `adb shell dumpsys batterystats --reset`, `adb shell dumpsys gfxinfo app.lazysh.client reset`.
3. Run one workload (for example `cat` of the W2 fixture on the host over SSH, then W0 idle for 5 minutes) while recording a Perfetto trace from the Perfetto UI "Record new trace" page with the scheduling, CPU frequency and idle, GPU, frame timeline, input and `webview` categories enabled; keep each trace short enough to open.
4. Collect: `adb shell dumpsys gfxinfo app.lazysh.client framestats` (frame pacing and janky frames), `adb shell dumpsys meminfo app.lazysh.client` (peak and steady memory, per-session by opening N sessions), `adb shell dumpsys batterystats app.lazysh.client` plus a bug report for energy attribution, and `adb shell dumpsys cpuinfo` for CPU share. A debuggable build and Chrome DevTools remote debugging (`chrome://inspect`) can add `Performance.getMetrics`-style counters for diagnosis but must not be used for the final figures.
5. Input-to-presentation needs an external reference (a high-speed camera or a photodiode); without one, an in-app marker plus the frame timeline gives an estimate that must be labelled as such.
6. Repeat at least five times per workload, keep the raw traces beside the JSON, and fill the schema above with `null` for anything the device cannot provide.

## Results

| Workload | xterm DOM (desktop Chromium) | xterm optimized: WebGL addon, hardware GL | xterm canvas addon; WebGL software GL | Native candidate(s) | Winner (per device) |
| --- | --- | --- | --- | --- | --- |
| W0, W1, W2, W3, W4, W9, W10, W12 | measured, [baseline](#measured-baseline) | measured, [shootout](#renderer-shootout-xtermjs-renderers-1323): on par or better except W3 frame pacing, W4 CPU and fixed memory | measured: much slower | not built, not measured | undecided; see [ADR 0001, amendment 1](adr-0001-terminal-runtime.md#amendment-1-2026-11-12-first-renderer-shootout-results) |
| W5, W6, W7, W8, W11, W13 | not implemented | not measured | not measured | not measured | undecided |
| All workloads on Android | not measured | not measured | not measured | not measured | undecided |

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
- The byte budget does not map to lines. A 256 KiB and a 1 MiB budget kept the same number of rows, so the budget appears to be enforced in coarse steps below a few MiB, and for a fixed budget the rows kept fall with the column count (10,267, 5,280 and 2,610 at 40, 80 and 160 columns) and with content. The default 4 MiB budget keeps about lazysh's default 5000 lines at 80 columns and fewer than 3000 at 160, so the line setting of 100 to 20000 cannot be honoured by a fixed byte budget; the mapping is part of [#1338](https://github.com/mihazs/lazysh/issues/1338).

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

What this says, and does not say:

- Adding workers scales aggregate throughput (10 sessions: 556, 1017 and 1684 MiB/s at 1, 2 and 4 workers) while the per-session credit latency falls, so the pool size is a real lever and is set from per-device data, not from this host ([#1339](https://github.com/mihazs/lazysh/issues/1339)). One worker parses plain text at about 650 MiB/s here; the style-heavy and wide-character workloads were roughly 5 to 10 times slower in the parse table above (taken on a busier host) and are the ones to measure on devices.
- IPC calls per MB: the native path issues none per chunk (credits are returned inside Rust after VT processing). The xterm path issues one `ack_output` per `write` callback, so at the 16 KiB maximum chunk that is at most 64 calls per MiB by construction; the actual count depends on how the transports chunk, and was not measured.
- With several sessions the p99 credit latency is 3 to 4 times the p95 (up to 16 ms with 10 sessions on one worker). The cause was not investigated; shared-host scheduling of the producer and worker threads is a candidate, queueing behind other sessions' windows is another.

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

## Acceptance of a candidate

A candidate may replace the fallback on a device only if, on that device, all of the following hold with the recorded environment: provisional targets from the [PRD](terminal-performance-prd.md#provisional-targets-not-measurements) are met or the improvement is otherwise justified in the ADR; no input-latency regression under heavy output; no correctness regression on the conformance fixtures; near-zero idle activity; stable memory across session churn.

## Regression benchmarks in CI

CI can only run what is reproducible on hosted runners: parse throughput of the core, per-session memory, golden-image comparisons and an injected-slowdown self-test. Device-only metrics follow a documented manual procedure and are not gated automatically ([#1341](https://github.com/mihazs/lazysh/issues/1341)).

## Existing, unrelated measurements

`docs/android-startup-cpu-budget.md` measures emulator startup behaviour for SystemUI ANR sensitivity. It is not a terminal measurement and is not used as a baseline here.

## Unresolved questions

- Best method for input-to-presentation on Android without external hardware.
- How to hold radios and brightness constant across energy runs on the available devices.
- Whether hosted CI can produce stable enough numbers for any latency threshold.
