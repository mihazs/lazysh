# What the Rust release profile costs and what it buys

The workspace release profile in the root `Cargo.toml` is `lto = true` (fat), `codegen-units = 1`, `strip = true`, `panic = "abort"`. Every published binary uses it: the desktop app (`tauri build`), the Android and iOS libraries, the companion `lazysh-agent`, and the F-Droid build. This page records what that choice costs to build, what thin LTO and more codegen units would save, and what they would cost at run time. The decision is [ADR 0007](../architecture/adr-0007-keep-fat-lto-release-profile.md): the profile stays as it is. Raw results: [rust-release-profile-1.txt](../architecture/benchmarks/rust-release-profile-1.txt). Tracking: [#2737](https://github.com/mihazs/lazysh/issues/2737), part of the build performance epic [#2736](https://github.com/mihazs/lazysh/issues/2736).

## How it was measured

Host: AMD Ryzen 9 5900X (24 threads), 31 GiB, Linux 7.3, rustc 1.99.0. The host was shared with other builds and agents, so the load average is recorded in the raw file for every build (1 minute load 5 to 33 before a build, and 189 once, before the five-second `off16` agent relink). Timing runs took a lock so only one ran at a time; nothing else could be prevented from running.

- Each build is pinned to four CPUs (`taskset -c 0-3`, `CARGO_BUILD_JOBS=4`, the companion workflow's own setting), with a fresh `CARGO_TARGET_DIR`. Only the profile differs, set through `CARGO_PROFILE_RELEASE_LTO` and `CARGO_PROFILE_RELEASE_CODEGEN_UNITS`; `strip` and `panic` are unchanged.
- Candidates: `fat` (current), `thin16`, `thin8`, `thin4` (`lto = "thin"` with 16, 8 and 4 codegen units) and `off16` (`lto = false`, 16 units, which is Cargo's own release default).
- Targets: `lazysh-agent` (`cargo build --release -p lazysh-agent --bin lazysh-agent`, the companion build, gnu rather than the CI's musl triple because `musl-gcc` is not installed here) and the desktop binary (`cargo build --release -p lazysh --features tauri/custom-protocol`, what `tauri build --no-bundle` links; native terminal off, a stub frontend `dist`). The `warm` rows keep the dependencies and touch one source file of the application crate, which is what a build with a restored `rust-cache` pays.
- Wall time is elapsed time. CPU time is user plus system time of the whole build. Peak RSS is the largest single process (`ru_maxrss` of the waited children), which is the link step, not the sum over the tree. Target size is `du` of the target directory; binary size is the stripped output.
- Runtime: the repository's own desktop sampler ([desktop runtime measurement](../desktop-runtime-measurement.md)), a CLI timing of the companion, and the terminal runtime's `parse_bench` and `perf_gate` ([terminal benchmarks](../architecture/terminal-benchmarks.md)). Binaries were interleaved round by round so a drifting load hits every candidate alike.

## Build cost

`lazysh-agent`, four CPUs, one sample per cell (the load average at the start of each is in the raw file):

| Profile | Cold wall | Cold CPU | Peak RSS | Warm wall | Warm CPU | Binary | Target dir |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fat (current) | 134 s | 238 s | 1,043 MiB | 53 s | 52 s | 12.8 MiB | 463 MiB |
| thin16 | 99 s (-26 %) | 274 s (+15 %) | 982 MiB | 26 s (-51 %) | 93 s (+80 %) | 15.1 MiB (+17.9 %) | 488 MiB |
| thin8 | 88 s (-34 %) | 244 s (+3 %) | 1,046 MiB | 26 s (-51 %) | 94 s (+81 %) | 14.7 MiB (+14.9 %) | 483 MiB |
| thin4 | 91 s (-32 %) | 254 s (+6 %) | 1,217 MiB | 21 s (-60 %) | 78 s (+50 %) | 14.4 MiB (+12.4 %) | 478 MiB |
| off16 | 91 s (-32 %) | 281 s (+18 %) | 1,014 MiB | 5 s (-91 %) | 5 s (-90 %) | 14.6 MiB (+14.0 %) | 453 MiB |

Desktop binary, four CPUs. The cold row of `fat` and the `off16` row were sampled twice because their two samples differ most:

| Profile | Cold wall | Cold CPU | Peak RSS | Warm wall | Warm CPU | Binary | Target dir |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fat (current) | 579 s, 611 s | 1,318 s, 1,421 s | 3.1 to 3.3 GiB | 296 s | 292 s | 54.0 MiB | 3.0 GiB |
| thin16 | 472 s, 439 s (-18 %, -28 %) | 1,629 s, 1,503 s (+24 %, +6 %) | 3.1 to 3.3 GiB | 131 s (-56 %) | 398 s (+37 %) | 61.6 MiB (+14.1 %) | 3.3 GiB |
| off16 | 359 s, 422 s (-38 %, -31 %) | 1,217 s, 1,365 s (-8 %, -4 %) | 3.1 to 3.3 GiB | 66 s (-78 %) | 162 s (-44 %) | 59.2 MiB (+9.6 %) | 2.7 GiB |

What this says, and does not say:

- Fat LTO with one codegen unit costs wall time on a four-CPU runner, mostly because the final optimization runs on one thread: a warm desktop rebuild takes five minutes with it and one to two without. The largest share of that is avoidable.
- The cold-build spread between two samples of the same candidate (579 s against 611 s; 359 s against 422 s) is 5 to 17 % on this shared host, so differences of that size are not evidence. The warm differences and the 18 to 38 % cold differences are larger than that spread.
- Thin LTO is not cheaper in CPU time: it needs 3 to 24 % more cold and 37 to 81 % more warm, because every codegen unit is optimized separately and again at link time. It saves wall time only where cores are free. `lto = false` is the only candidate that also saves CPU time on the desktop binary.
- Peak RSS of the largest process does not fall meaningfully (3.1 to 3.3 GiB for the desktop link in every profile). Memory is not a reason to change the profile.
- Every non-fat binary is 10 to 18 % larger (9.6 to 17.9 %). The release workflow holds packages to size ceilings ([release artifacts](../release-artifacts.md), `.changeset/release-artifacts.ts`), the APK has its own ceiling in `native-android-release-core`, and the desktop binary is bundled into the packages.
- Not measured: Android, iOS, macOS and Windows builds. The Android cross build of the app library did not complete locally (the vendored whisper.cpp CMake step needs the Tauri CLI's toolchain environment), so no Android build number is claimed. The `.so` it links is built from the same profile, so the size result above is the best available evidence, not a measurement of it.

## Run-time cost

Build time is only half of the comparison. The same profile also decides how the shipped code runs.

Desktop app, the repository's sampler, 8 interleaved runs per binary, 15 s idle window, Xvfb software rendering (median, then min to max):

| Profile | `coldStartMs` | `settledMs` | `startupCpuSeconds` | `idleCpuPercent` | `peakRssMiB` |
| --- | --- | --- | --- | --- | --- |
| fat | 351 (285 to 423) | 4,593 (4,466 to 4,666) | 0.61 (0.52 to 0.78) | 0.07 (0.07 to 0.13) | 470 (468 to 471) |
| thin16 | 348 (286 to 392) | 4,584 (4,476 to 4,651) | 0.62 (0.54 to 0.69) | 0.07 (0.00 to 0.13) | 473 (472 to 474) |
| off16 | 334 (286 to 419) | 4,557 (4,483 to 4,714) | 0.59 (0.55 to 0.76) | 0.07 (0.00 to 0.20) | 472 (472 to 474) |

The empty start page cannot tell the profiles apart. Start-up is dominated by WebKitGTK, and the spread inside one profile is larger than any difference between profiles. That is a statement about this measurement: it exercises no SSH session, no terminal output and no transfer, which is where the Rust code runs, and it is not an Android measurement. The [Android startup CPU budget](../android-startup-cpu-budget.md) diagnostic measures an emulator's CPU setting, not application code, and no device was available, so no Android startup claim is made for any profile.

`lazysh-agent`, a short-lived CLI, 10 interleaved rounds of 100 runs per binary on four dedicated CPUs, milliseconds per run (median over rounds, min to max):

| Profile | `--help` start | `ingest` CPU | `snapshot` | `usage` |
| --- | --- | --- | --- | --- |
| fat | 1.69 (1.65 to 1.92) | 3.30 (3.27 to 3.87) | 3.02 | 1.73 |
| thin16 | 1.76 (1.68 to 1.87) | 3.42 (3.36 to 3.57) | 3.07 | 1.81 |
| thin8 | 1.75 (1.64 to 1.90) | 3.42 (3.34 to 3.83) | 3.04 | 1.80 |
| thin4 | 1.74 (1.68 to 2.01) | 3.40 (3.34 to 3.93) | 3.05 | 1.78 |
| off16 | 1.81 (1.70 to 1.92) | 3.41 (3.37 to 3.55) | 3.07 | 1.79 |

Every non-fat build is 1 to 7 % slower on every command, never faster (the range is per command: `snapshot` 1 to 2 %, `ingest` and `usage` 3 to 5 %, start-up 3 to 7 %). The differences are small and the start-up ranges overlap, so none of this is a regression by itself; it is the direction of the whole table that matters.

Terminal runtime (`packages/terminal-runtime`, which the app links when built with `native-terminal`, and which then takes the root profile instead of its own), 5 interleaved rounds per profile; `def` is the crate's own release profile (no LTO, 16 units), which is what the `terminal-perf` job runs. MiB/s, median (min to max):

| Workload | def | fat | thin16 |
| --- | --- | --- | --- |
| plain text, VT only | 581 (572 to 585) | 579 (566 to 587) | 570 (532 to 584) |
| plain text, with frames | 74 (72 to 75) | 98 (91 to 98) | 86 (83 to 86) |
| full-screen redraw, with frames | 69 (66 to 70) | 82 (82 to 84) | 74 (73 to 74) |
| ANSI + truecolor, with frames | 47 (47 to 48) | 52 (51 to 53) | 51 (47 to 51) |
| `perf_gate` VT-only throughput | 532 (526 to 536) | 529 (527 to 539) | 474 (467 to 477) |

The libghostty core is Zig and does not change. The Rust code that builds frames does: thin16 is 10 to 12 % slower than fat LTO on the plain-text and redraw workloads, with non-overlapping ranges, and the crate's own profile (no LTO) is 11 to 32 % slower than fat. The `perf_gate` VT-only figure is 10 % lower with thin16 on that harness, against a floor of 100 MiB/s, so no gate would fail, but the margin to the frame-cost ratios is thinner. This is the one place where the current profile earns its build cost, and it is the hot path of the terminal programme ([#1303](https://github.com/mihazs/lazysh/issues/1303)).

## Decision

No profile is adopted ([ADR 0007](../architecture/adr-0007-keep-fat-lto-release-profile.md)). Thin LTO and `lto = false` cut wall time, by 18 to 38 % cold and by 56 to 78 % warm on the desktop binary, but each makes every binary 10 to 18 % larger against fixed package ceilings, is slightly slower in every command of the companion CLI, is 10 to 12 % slower (thin) or 11 to 32 % slower (no LTO) in the terminal frame path, and thin LTO costs more CPU time. The build-cost win is real, but it is bought from the published artifacts, and the criterion for adopting is a win that does not regress them.

## Rejected options

| Option | Why not |
| --- | --- |
| `lto = "thin"`, 16 / 8 / 4 units for every release build | Saves wall time (agent -26 to -34 % cold; desktop -18 % cold, -56 % warm) but CPU time rises (cold +3 to +24 %, warm +37 to +81 %), binaries grow 12 to 18 %, the CLI is 1 to 7 % slower, and terminal frame throughput is 10 to 12 % lower. |
| `lto = false`, 16 units for every release build | The cheapest build (desktop -38 % cold, -78 % warm, CPU -8 %) but binaries grow 10 to 14 %, the CLI is 1 to 7 % slower, and the terminal frame path is 11 to 32 % slower. |
| `thin` with one unit | Not measured; it removes the parallelism that makes thin cheaper in wall time, so it cannot beat the rows above. |
| `opt-level`, `panic`, `strip` variants | Not measured: `panic = "abort"` and `strip = true` are already the cheap settings, and `opt-level = "s"` trades speed for size, which the measurements above give no reason to want. |
| Thin or `lto = false` only for test builds that ship nothing | Would win (the same numbers apply, without the size and run-time costs), but it needs a per-job audit: several `checks.yml` jobs build the release binary precisely so the test runs against the codegen that ships, and the APK size gate must see the real `.so`. Recorded as a follow-up, not done here. |

## Limits of this evidence

One sample per build cell except the desktop (two cold samples), on a shared host whose load varied between 5 and 33. Four-CPU pinning approximates a hosted runner; it does not reproduce its memory, disk or noisy neighbours. The agent was built for the gnu triple, not musl. No Android, iOS, macOS or Windows build or run, no physical display, and no run with a connected session. The terminal figures are the host crate benchmarks, not the app's input-to-render latency.

## Reproduce

```sh
# Profile override without editing Cargo.toml; compare with CARGO_PROFILE_RELEASE_LTO=true and _CODEGEN_UNITS=1.
export CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 CARGO_BUILD_JOBS=4
CARGO_TARGET_DIR=/path/to/fresh/target taskset -c 0-3 cargo build --release --locked -p lazysh-agent --bin lazysh-agent
# touch apps/agent/src/main.rs and build again for the warm figure
bun tests/support/desktopRuntime.ts <binary> --runs 1 --idle 15      # desktop sampler
```

Build times and peak memory come from `getrusage` of the waited children (`/usr/bin/time` is not installed on the host). The terminal runtime builds as described in its [README](../../packages/terminal-runtime/README.md#build-and-test).
