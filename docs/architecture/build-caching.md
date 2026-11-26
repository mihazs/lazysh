# Build caching: sccache, Zig and the GitHub Actions caches

- Status: measured 2026-11-26, workstream 2 of [#2736](https://github.com/mihazs/lazysh/issues/2736), tracked in [#2742](https://github.com/mihazs/lazysh/issues/2742).
- Related: [ADR 0006](adr-0006-dagger-for-ci.md) (Dagger, rejected; it also found the 10 GB budget too small) · [release artifacts](../release-artifacts.md) · #2529, #384, #2098 (slow Zig package downloads)

## Decisions

| Option | Decision | Why, in one line |
| --- | --- | --- |
| Speech fixtures cache (626 MB per pull request) | Removed | A hit saved nothing: restore 3 to 9 s against a 4 to 14 s download. |
| Playwright browser cache (293 MB) | Removed | A hit (restore 2 to 7 s + install 8 to 13 s) was no faster than a miss (install 8 to 17 s). |
| moon cache of the `client` job | Removed | The entry is 45 KB and its key ends in the commit SHA, so a pull request never hits it exactly. |
| Windows Parakeet model cache (487 MB) | Removed | 0 hits in 5 runs; the download takes 3.6 s; saving it took 36 s a run. |
| Herdr crate download cache (32 MB, 4 jobs) | Kept | Linux fetches the locked crates in 1 s without it, but its macOS and iOS use was not measured. |
| Pinned downloads cache (Zig, fixtures) | Kept | A miss made the Zig step 133 to 1138 s instead of about 14 s; the one layer that protects against #2529. |
| sccache in CI | Rejected | See [sccache](#sccache). |
| sccache locally | Documented, opt-in | See [Using sccache locally](#using-sccache-locally). |
| Persistent Zig output caches | Rejected | See [Zig](#zig). |
| Android SDK, NDK and apt caches | Rejected | The install they replace is about 20 s a job and the entries would be 1.5 GB or more. |

The removals free 1.4 GB of the 10 GB budget (the speech entry alone was saved by every pull request that missed, 2.5 GB at once) and drop restore and save steps from jobs that gain nothing from them. No job's output changes: every removed cache held a download that its step re-verifies against a SHA-256 or lock file, or a tool that its step installs.

## Before and after

| Measure | Before | After (expected) | Basis |
| --- | --- | --- | --- |
| Budget in use, 2026-11-26 | 10.8 GB in 35 entries at 20:30 UTC, 10.1 GB in 43 at 21:30 UTC | 1.4 GB less at once, up to 3.3 GB less when several pull requests hold a speech entry | cache API |
| Pull request scoped bytes | 3.2 GB in 21 entries | about 0.7 GB (pinned downloads only) | cache API |
| `client` job cache steps | 3 (`bun`, moon, Playwright) | 1 (`bun`) | workflow |
| `native-linux-runtimes` | 626 MB restore, 3 to 9 s, plus 4 s save on a miss | 4 to 14 s download, no cache step | step timings |
| `native-desktop (windows-latest)` | 36 s post-step save, 487 MB | none | step timings |
| Compile time of any job | unchanged | unchanged | none of the removed layers held build output |

"After" is projected from the sizes and times above. A hosted run is the only proof; the wall-time change of each job is inside runner noise by construction (the removed steps cost 2 to 36 s), and the value is the budget: with the speech entry gone, the entries that save 100 to 700 s (`rust-cache`) are evicted less often.

## How this was measured

- Cache inventory: `gh api repos/mihazs/lazysh/actions/caches` and `.../cache/usage`, 2026-11-26 about 20:30 UTC.
- Hit rates and per-step times: logs and step timings of 52 successful jobs from 15 green `checks.yml` runs of 2026-11-25 and 2026-11-26 (`agent`, `native-terminal-bridge`, `native-android`, `native-linux-runtimes`, `native-linux`, `herdr-native`, `client`), plus Windows jobs from the last `main` runs. In the Rust table, "cold" means no Rust cache was restored; "exact" and "partial" are `rust-cache`'s `full match: true` and `false`.
- Hosted-runner numbers are medians with the sample size beside them, and carry runner noise of roughly 10 %: a smaller difference is called no difference.
- Local numbers (sccache, Zig): one machine shared with other benchmarks, 8 pinned cores (`taskset -c 8-15`), under `flock /tmp/claude-drive/bench.lock`, load average recorded with each result.
- Limit: a workflow change is proven only by a hosted run. The removals are deletions of steps whose output nothing else reads, checked with `actionlint` (no new finding) and the CI structure tests (`checks-step-conditions`, `main-verdict`, `moon-graph`, `native-changes`: 156 pass); the first pull request run after merge is the real check.

## The 10 GB budget

On 2026-11-26 the repository held 10.8 GB in 35 caches, over GitHub's limit, so entries were being evicted by least recent use while this was measured. Before and after this change:

| Layer | Scope | Entries | Size | Hit rate (sampled jobs) | Measured benefit | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `rust-cache`, 6 jobs | main | 5 | 6.6 GB | see [Rust caches](#rust-caches) | 100 to 200 s a job, 7 to 11 min on `native-linux` | Kept |
| Speech fixtures | pull request | 4 at peak | 626 MB each | 5 of 13 | none | Removed (-0.6 to -2.5 GB) |
| Pinned downloads | main and pull request | 20 | 0.9 GB | 17 of 54 | avoids 133 to 1138 s Zig stalls | Kept |
| Windows Parakeet model | main | 1 | 487 MB | 0 of 5 | negative | Removed (-0.5 GB) |
| Gradle (`modules-2`, wrapper) | main | 1 | 472 MB | 17 of 17 | restore 6 s; keeps Maven Central off the critical path | Kept |
| `bun install` | main, Linux and macOS | 3 | 470 MB | 70 of 70 | `bun install` takes 2 to 4 s warm; no cold run observed | Kept |
| Playwright Chromium | main | 1 | 293 MB | 24 of 28 | none | Removed (-0.3 GB) |
| Herdr crate downloads | pull request and main | 4 | 100 MB | 8 of 15 | none on Linux (1 s either way); macOS and iOS not measured | Kept |
| Parakeet ONNX Runtime archive | main | 1 | 24 MB | 31 of 39 | avoids a GitHub release download | Kept |
| moon, `client` job | main | 1 | 45 KB | 4 of 15 (all partial) | none | Removed |

### Rust caches

Medians per job, seconds. `step` is the job's longest compile step, `job` its whole duration; n is in brackets.

| Job | Cold | Exact | Partial | Warm saves (step) |
| --- | --- | --- | --- | --- |
| `native-linux` | step 1916, job 4106 (11) | step 1504, job 3428 (1) | step 1234, job 2852 (1) | 410 to 680 s |
| `native-terminal-bridge` | step 534, job 1448 (4) | step 416, job 1299 (3) | step 411, job 1141 (5) | 120 s |
| `native-android` | step 799, job 977 (7) | step 654, job 844 (5) | step 600, job 796 (1) | 145 to 200 s |
| `native-linux-runtimes` | step 348, job 1089 (6) | step 251, job 1035 (4) | step 242, job 996 (2) | 100 s |

`herdr-native` has no Rust cache. It compiles three Herdr targets from scratch every run (3 min 12 s, 3 min 4 s and 3 min 36 s of `cargo build`, 587 crates), which is the largest compile in CI that nothing reuses.

Findings:

1. The entries pay (100 to 200 s a job), but 21 of 52 sampled jobs found none: the budget is over, so least-recently-used entries are evicted before the next run, and `native-linux` (an hour long) found a main entry in 2 of 13 runs. Its entry is absent from the list today.
2. Only a successful `main` job saves, and `main` rarely completes: of the last 60 `main` push runs of `checks.yml`, 51 were cancelled (a new push replaces the one pending run of the concurrency group) and 7 failed. The nightly run is the main source of entries.
3. `rust-cache` hashes `Cargo.lock`, and every Changesets version PR changes it (10 changes in two days), so each release writes a new generation of about 1 GB a job and keeps the old one until evicted. A partial restore still works, because `rust-cache` falls back to the newest entry with the same prefix.

### What the removed layers cost

- Speech fixtures: `main` never saved one, so every pull request that missed saved its own 626 MB copy, readable by that pull request alone. Four of them held 2.5 GB, a quarter of the budget.
- Windows Parakeet: the `native-desktop (windows-latest)` job runs on `main` only and its entry was evicted before the next run (0 hits in 5 runs); the post-step that uploaded 487 MB took 36 s. Windows also spends 82 s saving the bun cache and 96 s saving `rust-cache` after a miss, and both missed in 4 of the 5 runs; that is listed under follow-ups.
- Playwright: restore plus install on a hit (`client` median 26.5 s over 14 runs, `native-linux-runtimes` 10 to 20 s) against install alone on a miss (19 s, 8 to 17 s).
- moon: the entry holds task hashes only (45 KB). A pull request runs only tasks its diff affects, whose input hashes differ from `main`'s, so a restored entry cannot skip them.

### What a pinned download miss costs

`.github/actions/ghostty-zig` (Zig 0.16.0 from `ziglang.org`, three Ghostty archives from `deps.files.ghostty.org`) took 10 to 15 s when the pinned-downloads cache hit, and 36 to 136 s typically and 378 to 1138 s on six occasions when it missed. This is the slow-download problem of #2529, #384 and #2098; the cache is its cheapest defence and is kept for pull requests too. Making `main` save it more often is a follow-up.

## Zig

Libghostty-vt is built by `zig build` from the `ghostty-vt` build script (`packages/herdr-upstream/crates/ghostty-vt/build.rs`), always in `ReleaseFast`, whatever Cargo profile is used. Zig 0.16.0, the x86_64 Linux GNU target, 8 pinned cores (`taskset -c 8-15`), one fresh `ZIG_GLOBAL_CACHE_DIR` and `ZIG_LOCAL_CACHE_DIR` per row, run under the shared bench lock (load average 4.9 to 8.8 at the start of each run):

| Cache state at the start | Wall | CPU (user + sys) | Peak RSS | Notes |
| --- | --- | --- | --- | --- |
| Both empty (cold) | 65.7 to 73.2 s | 175 to 186 s | 0.8 to 1.0 GB | global 93 MB, local 307 to 412 MB afterwards |
| Global `o`, `h`, `z` kept, local empty | 49.4 to 49.9 s | 124 to 126 s | 0.8 to 1.0 GB | -25 % wall and -31 % CPU against the mean of the three cold-start rows (66.6 s, 179 s) |
| Both kept, same inputs | 0.1 s | 0.2 s | 41 MB | Zig finds every artifact; byte-identical `libghostty-vt` |
| Package tarballs only (`zig-global/p`), the layer CI keeps today | 61.0 s | 174.5 s | 0.9 GB | the same as cold: `p` holds downloads, not compiled output |

Rows are single runs (cold n = 3 counting the p-only row, global kept n = 2); the spread between runs of one row is 1 to 12 %. Limit: x86_64 Linux GNU only. The Android targets need the NDK, which this machine lacks, so they were not measured; they share the build runner and standard-library objects, so the saving should be of the same size per ABI.

What CI does today: `ghostty-zig` caches only `zig-global/p`, the hash-addressed package tarballs, keyed by the `build.zig.zon` files. That layer is what protects against the slow `deps.files.ghostty.org` and `ziglang.org` downloads of #2529, #384 and #2098: a miss made the step 133 to 1138 s on six of 17 sampled jobs and a hit made it 10 to 15 s. Inside a job the guarded builds of `herdr-native` (debug, release, tests) already share one `ZIG_GLOBAL_CACHE_DIR` and `ZIG_LOCAL_CACHE_DIR`, so a rebuild with unchanged inputs costs about the "both kept" row's 0.1 s; a second target (an Android ABI) reuses the build runner and standard-library objects only. The stock Herdr build uses its own directories on purpose, to stay independent of the guarded build.

Rejected, with the numbers:

- **Persist `zig-global/o`, `h`, `z` across runs (91 MB):** saves 12 to 23 s of wall time and about 50 CPU-seconds per cold libghostty build. `herdr-native` has two cold directories (guarded and stock), so 24 to 46 s of 1056 s, under 4 %; every other job builds once, under 2 %. It also makes jobs restore compiled executables (Zig's build runner) from a cache. Not worth the extra write path at this size.
- **Also persist `zig-local` (307 to 412 MB uncompressed):** saves about 65 s of wall time per Zig build when the inputs match (the 0.1 s row), about 5 % of `native-terminal-bridge`. Zig keys by target, so a useful cache needs one entry for x86_64 Linux and one per Android ABI, in a budget that is already over (10.8 of 10 GB), and only a successful `main` job could save them, which `main` rarely is ([Rust caches](#rust-caches)). Revisit after the budget is fixed and the `native-linux`-style entries survive; the number to beat is 65 s a build.
- **One shared Zig cache for the guarded and stock Herdr builds:** the stock build is independent evidence by design.
- **`zig-global/p` for the Android jobs under a separate key:** the existing key already covers them (`herdr-zig-packages`, 27 of 27 hits).

Release jobs keep `restore-only` for `zig-global/p` and restore no compiled output, so every shipped library is compiled from source.

## sccache

Measured with sccache 0.20.1 (the official musl release, SHA-256 checked), local disk backend, Rust 1.96.1, `taskset -c 8-15`, a fresh target directory per row, under the shared bench lock (load 5.6 to 7.8). `lazysh-agent` stands for the Rust workspace (268 compile requests, 1.8 GB target, dev profile, `cargo build -p lazysh-agent`); `whisper-rs-sys` 0.15.0 built from a scratch crate (default stable Rust 1.99.0, without the app's `.cargo/config.toml` `GGML_*` flags) stands for the CMake and C/C++ side, whisper.cpp and ggml (74 requests). CPU time is not shown: the sccache server does the compiling and is not a child of the build.

| Build | Wall | sccache hit rate | Cache size |
| --- | --- | --- | --- |
| `lazysh-agent`, no sccache | 24.5 s | n/a | n/a |
| `lazysh-agent`, sccache, empty cache | 26.9 s (+10 %) | 0 of 221 | 129 MiB |
| `lazysh-agent`, sccache, warm | 19.9 s (-19 %) | 207 of 221 (94 %) | 188 MiB |
| `whisper-rs-sys`, no sccache | 29.0 s | n/a | n/a |
| `whisper-rs-sys`, sccache, empty cache | 30.7 s (+6 %) | 6 of 60 | 168 MiB |
| `whisper-rs-sys`, sccache, warm | 27.7 s (-4.5 %) | 33 of 60 (55 %) | 204 MiB |

Reading the numbers: a fully warm sccache saves a fifth of a dev build and costs a tenth on an empty cache. The rest is not cacheable: linking, build scripts, proc macros and the CMake configure and link steps. The C/C++ side hit only 55 % warm because CMake puts the build directory into every compile command and each row used a different target path; the same path would hit more. Rows are single runs; treat differences under 10 % as noise.

Decision for CI: **rejected**.

- `rust-cache` already restores the same compiled dependencies (it saves 100 to 200 s a job), so sccache would be a second layer for the same objects. Its GitHub Actions backend writes into the same 10 GB budget, so it does not escape the eviction problem; its entries are per compile unit and add a request per unit.
- A fully warm sccache saves 19 % of a dev build here; `rust-cache` restores the whole target for jobs that run the same build, which is why they compile less.
- Compiler caches must not touch release, signing or F-Droid jobs ([cache poisoning](#cache-poisoning-and-the-release-jobs)), so the only candidate jobs are the test jobs where `rust-cache` is already in place.
- Release builds use `lto = true`, `codegen-units = 1`: the final crates are not cacheable across source changes either way.

Decision for local use: **opt-in, documented, not configured in the repository.** `.cargo/config.toml` is shared by CI and by release builds, so a `rustc-wrapper` there would put sccache into jobs where it must not be.

### Using sccache locally

It pays when you keep several worktrees, as this repository's workflow does: every worktree has its own `target`, and the second one compiles from the shared cache instead. Install it (`cargo install sccache --locked`, or your package manager) and export, in your shell profile and not in the repository:

```sh
export RUSTC_WRAPPER=sccache
export CMAKE_C_COMPILER_LAUNCHER=sccache    # whisper.cpp, ggml, the Parakeet native build
export CMAKE_CXX_COMPILER_LAUNCHER=sccache
export SCCACHE_CACHE_SIZE=20G               # the default is 10G; a Rust target here is 1.8 GB
```

`sccache --show-stats` reports hits and misses; `sccache --zero-stats` resets them. Notes:

- sccache cannot cache a crate that Cargo compiles incrementally, which is every workspace crate in the dev profile; it caches dependencies. Unset `RUSTC_WRAPPER` if it ever gets in the way of a tight edit loop.
- Entries depend on the compiler version, flags and paths, so worktrees share the crates from `~/.cargo/registry` that were built with the same flags, but workspace crates at different worktree paths do not share.
- Never set these variables for a release or signing build. A cached object is produced by whoever wrote it last; release builds must compile from source.
- Zig is not covered by sccache. Zig has its own content-addressed cache in `ZIG_GLOBAL_CACHE_DIR` and `ZIG_LOCAL_CACHE_DIR`; point both at a directory outside any worktree (`~/.cache/zig` for the global one) to share it, as the CI jobs do within a job.

## Cache poisoning and the release jobs

A cache is an input of the job that restores it. A job that signs or publishes must not take build output from a place a lower-trust job can write.

What the repository already does, and this change keeps:

- A pull request writes only to its own `refs/pull/N/merge` scope. Entries there are unreadable by `main`, by release workflows and by other pull requests, so a pull request cannot plant bytes that a release restores.
- `release-artifacts.yml` restores no `target/` and no Gradle `build/`; every release binary compiles from source. It restores only download caches in `restore-only` mode (`setup-bun`, `cargo-registry`, `ghostty-zig`, the Gradle dependency cache) and never saves.
- Restored downloads are checked against a pin before use: Zig against the package hash in `build.zig.zon`, `pinned-download.sh` and the ORT step against a SHA-256, Cargo against the `Cargo.lock` checksums, `bun install --frozen-lockfile` against `bun.lock` integrity.
- `companion-artifacts.yml` restores `rust-cache` only for candidates (`!inputs.stage`), never for release staging.

Findings and rules for new caches:

- The Gradle dependency cache is the one restored layer that no hash pins: the repository has no `gradle/verification-metadata.xml`, so Gradle trusts the jars in `~/.gradle/caches/modules-2`. Only `main` writes it and the release job reads it without saving. That is the standing risk of any `main`-written cache read by a release; Gradle dependency verification would close it (follow-up).
- A compiler cache (sccache, ccache) must never run in a release, signing, provenance or F-Droid job. It replays object code from storage, so the output would depend on whoever last wrote the entry. It is for development and for jobs whose output is only tested.
- Zig output caches (`zig-global` outside `p/`, `zig-local`) follow the same rule. Only `zig-global/p`, the hash-addressed package tarballs, is cached.
- A pull request never saves to a key that `main` reads. Use `actions/cache/restore` on pull requests and `actions/cache/save` guarded by `github.ref == 'refs/heads/main'`.

## Follow-ups

- Make the `native-linux` Rust cache exist: seed it from the nightly run, or let `main` push runs finish. Worth 7 to 11 min a run; costs one extra hour-long job a night, a CI-minutes trade for the owner.
- Gradle dependency verification, so the Gradle cache can reach signing jobs without trusting its contents.
- Windows saves a bun cache (82 s) and a Rust cache (96 s) that 4 of 5 runs did not find; stop saving them or find out why they are evicted.
- Shrink the 1.1 to 1.5 GB Rust cache entries, a Cargo profile question for the profile workstream.
- Let `main` save the pinned-downloads cache whenever it is missing, so pull requests stop paying 133 to 1138 s on a cold `ziglang.org`.
