# Build performance: dev profile, lightweight build and parallelism

What a developer or CI job can change to build and test the app crate (`apps/client/src-tauri`, Cargo package `lazysh`) faster,
with the measurements behind every adopted and every rejected option. Tracking issue: #2740, part of #2736. Release builds are
not covered here and did not change: [`[profile.release]`](../../Cargo.toml), the default feature set, the artifacts and every
quality gate stay as they were.

## What changed

| Change | Who sees it | Release impact |
| --- | --- | --- |
| `[profile.dev] debug = "line-tables-only"` in the root `Cargo.toml` | every `cargo build`, `cargo test`, `cargo check` and `cargo clippy` of the workspace, in CI and locally | none: the release profile is untouched |
| Cargo feature `local-voice` (on by default) gates Whisper and the native Parakeet runtime | `cargo ... --no-default-features` builds the lightweight development build; every other build compiles both exactly as before | none: `default = ["local-voice"]`, so release, F-Droid and CI builds resolve the same graph |
| `lazysh-parakeet-runtime` CMake jobs: half the CPUs between 4 and 12 when `CMAKE_BUILD_PARALLEL_LEVEL` is unset (was a fixed 4) | developers with more than 8 CPUs; hosted runners and the release workflows keep 4 | none: a speed setting, the artifact is the same |
| Moon tasks `client-native:check-rust-light` and `client-native:test-rust-light` | developers | none: no workflow runs them |
| `client-native:test-feature-graph` (part of `verify-native`) | CI | proves the default build still carries Whisper and Parakeet, and that `--no-default-features` carries neither |

## The lightweight development build

```sh
cd apps/client/src-tauri
cargo check --no-default-features --lib          # or: bunx moon run client-native:check-rust-light
cargo test  --no-default-features --lib          # or: bunx moon run client-native:test-rust-light
```

`--no-default-features` drops `local-voice`, so Cargo compiles neither `whisper-rs` (its CMake/C++ `whisper-rs-sys` build) nor
`lazysh-parakeet-runtime` (its CMake/C++ sherpa-onnx build, the longest single step of a clean build). The Whisper commands stay
registered; `voice_transcribe` answers "Local Whisper is not part of this lightweight development build", and the Parakeet
commands answer as they do on a target without Parakeet. Use it when a change does not touch voice. Never use it to produce
something that is run, released or measured: it has no local transcription.

Ghostty (`libghostty-vt`, Zig) and wgpu were already opt-in through the `native-terminal` feature (#2201), so no default build
compiles them and no build needs Zig. `checks.yml` already proves that with `cargo tree -i wgpu`.

| Build | Compiles Whisper | Compiles Parakeet | Compiles Ghostty and wgpu |
| --- | --- | --- | --- |
| default (all release, F-Droid and CI builds today) | yes | Linux and Windows x86_64, and Android with `parakeet-android` | only with `--features native-terminal` |
| `--no-default-features` (lightweight, opt-in) | no | no | only with `--features native-terminal` |

`lazysh-parakeet-runtime` carries a `native` feature (default on) for the same purpose: without it the crate is empty and its
`build.rs` runs no CMake. The app turns it on through `local-voice`, `parakeet-android` and `parakeet-acceptance`, so no existing
build changes.

## Measurements

All runs on one Linux x86_64 host (24 logical CPUs, 31 GB RAM, NVMe), Rust 1.99.0, `cargo test --locked --no-run` in
`apps/client/src-tauri` from a clean target directory, one run at a time under a shared lock. Peak memory is the cgroup
`memory.peak` of the whole process tree; CPU is user plus system seconds of the same cgroup. The host is shared, so wall time
carries noise (load at start is in the raw log); CPU time and sizes are the steadier columns. One run per row: differences under
about 10 % are not conclusions.

### Dev and test profile (full dependency graph, defaults otherwise)

| Variant | Clean wall | Clean CPU | Peak memory | Target dir | Test binary | Incremental (touch `lib.rs`) | `cargo test --lib` run |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before: `debug = 2` (Cargo default) | 215 s | 1264 s | 8.3 GB | 12 GB | 812 MB | 12.7 s | 15.3 s |
| `debug = "line-tables-only"` (adopted) | 199 s | 1150 s | 5.7 GB | 7.0 GB | 314 MB | 10.5 s | 15.4 s |
| `debug = 0` | 193 s | 1069 s | 4.8 GB | 5.3 GB | 175 MB | 9.5 s | 15.3 s |
| `split-debuginfo = "unpacked"` | 207 s | 1230 s | 7.5 GB | 9.2 GB | 306 MB | 10.3 s | 15.3 s |
| dependencies `debug = 0`, workspace `line-tables-only` | 232 s | 1223 s | 5.2 GB | 5.8 GB | 243 MB | 10.4 s | 15.3 s |
| dependencies `debug = 0`, workspace full debuginfo | 198 s | 1121 s | 7.2 GB | 8.3 GB | n/a | 10.7 s | 15.3 s |
| dependencies `opt-level = 1`, workspace `line-tables-only` | 223 s | 2113 s | 5.4 GB | 7.0 GB | n/a | 9.4 s | 15.3 s |

Decision: **`line-tables-only` for the whole workspace profile is adopted.** It cuts clean CPU by 9 %, peak memory by 31 %, disk by
42 % and the test binary by 61 %, and keeps file and line in panics and backtraces. A debugger session that inspects locals
sets `CARGO_PROFILE_DEV_DEBUG=2` for that run. Rejected:

- `debug = 0`: a further 7 % CPU, but backtraces lose their lines. Not worth the loss for the first case.
- `split-debuginfo = "unpacked"`: 3 % CPU and a smaller drop in memory and disk than `line-tables-only`, plus extra `.dwo` files.
- Dependencies without debuginfo but workspace with it: no memory win (the app crate's own debuginfo dominates peak memory) and
  no wall win over `line-tables-only` for everything.
- Dependency `opt-level = 1`: 1.7 times the CPU to build, and the 795-test `--lib` run did not get faster (15.3 s either way),
  so there is nothing to win back.
- `build-override` and `incremental`: the defaults already build scripts at `opt-level = 0` without debuginfo and the dev profile is
  already incremental; touching either changed nothing worth a row.

The test run time is the same in every row: the test suite does not spend its time in dependency code that debuginfo or
`opt-level` would change.

### Lightweight development build

| Build (`--no-default-features` against default) | Clean wall | Clean CPU | Peak memory | Target dir | Incremental | `voice::` tests |
| --- | --- | --- | --- | --- | --- | --- |
| default, `debug = 2` (before) | 244 s | 1366 s | 9.8 GB | 12 GB | 14.8 s | 45 passed, 4 ignored |
| lightweight, `debug = 2` | 116 s | 834 s | 9.6 GB | 11 GB | 11.2 s | 30 passed, 3 ignored |
| lightweight, `line-tables-only` (both adopted changes) | 106 s | 749 s | 6.3 GB | 6.1 GB | 8.4 s | 30 passed, 3 ignored |

Without the two CMake builds a clean build needs 39 % less CPU and, with the profile change, half the disk (6.1 GB against 12 GB). The fifteen tests that remain out are the Whisper and Parakeet
ones; the lightweight build has its own test of the "not compiled" answer. The default build is checked by `cargo clippy
--all-targets -D warnings` and the 45 `voice::` tests on the same tree.

### Parallelism budget

The workflows already pin the nested builds on the hosted runners (`CARGO_BUILD_JOBS` 2 or 4, `CMAKE_BUILD_PARALLEL_LEVEL` 4), and
the Parakeet `build.rs` used a fixed 4 CMake jobs when nothing was set, whatever the machine. A clean app build is limited by
that one step: the `lazysh-parakeet-runtime` build script ran 156 s of a 244 s build (Cargo timings, 24 CPUs), while the other
crates compile around it. The budget below is the rule the repository now follows.

| Layer | Budget | Where |
| --- | --- | --- |
| Cargo | one job per CPU (Cargo's default); `CARGO_BUILD_JOBS` 2 to 4 on a hosted runner | unchanged |
| CMake (Parakeet, Whisper, mosh) | `CMAKE_BUILD_PARALLEL_LEVEL` if set, else half the CPUs clamped to 4..12 | `packages/parakeet-runtime/build.rs`; Whisper's `cmake` crate follows Cargo's job count |
| Zig (`native-terminal`) | its own default (all CPUs); the Zig step is outside the default build | unchanged |
| Gradle | `org.gradle.workers.max` and `org.gradle.parallel` unset, daemon heap `-Xmx2048m` | unchanged, not measured (below) |
| Bun and moon | `-c 1` on moon when one timing-sensitive target must not share the machine | unchanged |

Clean `cargo test --no-run` of the app crate, new dev profile, default features, 24 CPUs, same host and lock:

| CMake jobs | Wall | CPU | Peak memory |
| --- | --- | --- | --- |
| 4 (the former fixed default) | 212 s, 267 s | 1200 s, 1239 s | 5.9 GB, 5.7 GB |
| 12 (the new default on 24 CPUs) | 171 s, 169 s | 1301 s, 1273 s | 6.6 GB, 6.3 GB |

The second run of each pair started while another session pushed the host load to 49, so the 267 s is an outlier; both 12-job
runs finished in 169 to 171 s. **Adopted:** 20 % less wall on a 24-CPU machine for 8 % more CPU and 0.6 GB more peak memory.
The Parakeet build alone shows the trend and its limit:

| CMake jobs (Parakeet runtime alone) | Wall | CPU | Peak memory |
| --- | --- | --- | --- |
| 4 | 112 s | 301 s | 2.0 GB |
| 12 | 94 s | 473 s | 4.4 GB |
| 24 | 81 s | 537 s | 6.8 GB |

More than 12 jobs buys 14 s and 2.4 GB, so the clamp is 12. A 4-CPU machine, a hosted runner and every workflow that sets the
variable keep 4.

Rejected, measured on 4 pinned CPUs (`taskset -c 0-3`, same host, loaded by other sessions: wall is indicative only):

| Run | Wall | CPU | Peak memory |
| --- | --- | --- | --- |
| defaults (old dev profile) | 279 s | 892 s | 7.7 GB |
| defaults (new dev profile) | 260 s | 831 s | 6.4 GB |
| `CARGO_BUILD_JOBS=4` `CMAKE_BUILD_PARALLEL_LEVEL=2` | 337 s | 847 s | 5.6 GB |
| `CARGO_BUILD_JOBS=2` `CMAKE_BUILD_PARALLEL_LEVEL=2` | 393 s | 784 s | 6.2 GB |

Lowering Cargo or CMake jobs on 4 CPUs saved 5 to 12 % of CPU and 1.2 to 2.1 GB of peak memory and cost 30 to 50 % of wall
time, so oversubscription is not the problem on these builds and no lower budget is adopted. Peak memory comes from the largest
single crate (the app crate and its test binary), not from the number of jobs, which is why the profile change (-31 %) helps more
than any jobs change.

Gradle and Zig were not measured: this host has no Android SDK, JDK or Zig, and the Android build and Zig caching belong to other
workstreams of #2736. `org.gradle.parallel` and `org.gradle.workers.max` stay unset; nothing here is evidence for or against them.

## Reproduce

```sh
# profile variants: any CARGO_PROFILE_DEV_* variable or a [profile.dev] table
CARGO_PROFILE_DEV_DEBUG=0 cargo test --locked --no-run
# lightweight
cargo test --locked --no-default-features --no-run
# the guards
bun test tests/cargo-feature-graph.test.ts
```
