# Terminal benchmarks

Status: **design only. No measurement has been taken.** Every results table in this document is empty on purpose. A number may be quoted elsewhere in `docs/architecture` only if it comes from this suite, with its environment block. Tracking: harness [#1303](https://github.com/mihazs/lazysh/issues/1303), renderer shootout [#1323](https://github.com/mihazs/lazysh/issues/1323), CI regression [#1341](https://github.com/mihazs/lazysh/issues/1341), Android energy [#1340](https://github.com/mihazs/lazysh/issues/1340). Related: [PRD](terminal-performance-prd.md) · [native rendering](native-rendering.md).

## Principles

1. **Baseline before optimizing.** The first run measures the current xterm.js 5.5.0 DOM renderer and an optimized xterm.js variant (renderer addon and binary IPC); nothing else is compared until those exist.
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

## Result schema (proposed)

Versioned JSON, one file per run, stored beside the documentation of that run:

```json
{
  "schema": 1,
  "workload": "W2",
  "candidate": "xterm-dom",
  "environment": { "device": "", "soc": "", "ramMb": 0, "os": "", "refreshHz": 0, "commit": "", "profile": "release" },
  "metrics": { "inputToRenderMs": { "p50": null, "p95": null, "p99": null }, "frameMs": { "p50": null, "p95": null },
               "droppedFrames": null, "cpuMs": null, "peakRssMb": null, "energyMwh": null },
  "correct": null,
  "notes": ""
}
```

Unmeasured fields are `null`, never zero.

## Results

| Workload | xterm DOM | xterm optimized | Native candidate(s) | Winner (per device) |
| --- | --- | --- | --- | --- |
| all | not measured | not measured | not measured | undecided |

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
