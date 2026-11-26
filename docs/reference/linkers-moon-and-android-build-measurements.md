# Linkers, codegen backends, moon granularity and the Android build: measurements and decisions

This page records what was measured for the epic [#2736](https://github.com/mihazs/lazysh/issues/2736)
(child issue [#2739](https://github.com/mihazs/lazysh/issues/2739)) and what was decided for each option. Nothing here changes
a release artifact: the release profile, signing, provenance, F-Droid's source build and every quality gate are untouched.
Read the numbers with the limits at the end.

## Decisions

| Option | Decision | Reason in one line |
| --- | --- | --- |
| mold as the dev/test linker | **Opt-in**, documented below; not in the repository config, not in CI | 17 to 21 percent less CPU on a clean test build, 20 percent less wall time on the desktop crate (255 against 318 s), 3.5 to 6 times less CPU on an incremental relink; but Linux only and a new tool |
| wild as the dev/test linker | Rejected | More CPU than the default linker in both builds (+27 percent clean, +86 percent incremental) |
| Cranelift codegen backend | Rejected | Nightly only; no build-time gain over nightly LLVM (clean -6 percent CPU, incremental +8 percent); the agent's unit tests abort under it |
| Plain nightly toolchain | Rejected | Faster on this crate, but forces nightly on contributors and F-Droid has no use for it; see the table |
| Skip the browser suites when the change cannot reach the client | **Adopted** ([#2741](https://github.com/mihazs/lazysh/pull/2741)) | 2977 s of the `client` job's 52 minutes |
| Drop `check-rust` from the `agent` job | **Adopted** ([#2748](https://github.com/mihazs/lazysh/pull/2748)) | clippy already compiles everything check does; 18 percent CPU and 40 percent wall on the agent crate |
| One cargo run per verb instead of one per crate in the moon tasks | Follow-up [#2759](https://github.com/mihazs/lazysh/issues/2759) | 17 percent less CPU on the companion crates, needs a runner measurement |
| Build the x86_64 emulator APK once and share it | Follow-up [#2760](https://github.com/mihazs/lazysh/issues/2760) | about ten jobs rebuild it; needs a workflow change that cannot be exercised locally |
| Gradle parallel, daemon heap, configuration cache | Rejected | Gradle is under 100 s of a 14.7 minute job and a local rerun shows no difference |
| Per-ABI builds in test jobs | Nothing to change | No job compiles all four ABIs |
| R8 and minification | Not touched | Release behaviour; out of scope by the release guarantees |

## Toolchain facts the decisions rest on

- CI uses `dtolnay/rust-toolchain@stable` for most jobs and `1.96.1` for the Android and iOS native jobs; the F-Droid recipe
  runs `rustup default 1.99.0`. There is no `rust-toolchain.toml`, and `.moon/toolchains.yml` leaves Rust unpinned.
- Since Rust 1.90 the default linker on `x86_64-unknown-linux-gnu` is `rust-lld` (checked: a hello-world link line on 1.96.1
  contains `-fuse-ld=lld`, and the binary's `.comment` says `Linker: LLD`). So "the default" below is already LLD, not GNU ld.
- The Cranelift backend and every `-Z` option need a nightly toolchain. Adopting one for any CI job or the F-Droid recipe would
  put a nightly on a path that is meant to build with a stable, packaged toolchain.
- mold and wild are Linux ELF linkers. They do not apply to macOS, iOS (Apple's linker), Windows (MSVC link) or Android (the NDK
  links with its own `lld`).

## Linkers and codegen backends

Method: the same commit (`dd8397c8`), one worktree, a separate `CARGO_TARGET_DIR` per variant, `cargo test --locked --no-run -p lazysh-agent`
(the crate has 68 test targets, so it is link heavy), `CARGO_INCREMENTAL=1`, stable 1.99.0 unless the row says nightly (1.102.0-nightly
2026-11-25), mold 3.0.0, wild 0.11.0, GCC 16.2 as the linker driver. Every variant ran under `flock /tmp/claude-drive/bench.lock`. "Clean" deletes
the target directory first (2 runs). "Incremental" appends a comment to `apps/agent/src/lib.rs` and rebuilds (3 runs). CPU is user plus system
seconds of all child processes. Tests: `cargo test --lib -p lazysh-agent` after the build (306 expected).

| Variant | Clean wall | Clean CPU | Incremental wall | Incremental CPU | Peak RSS | Target | Unit tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default (LLD), stable | 45.6, 45.4 s | 470.5, 466.8 s | 14.6, 14.1, 15.6 s | 157.7, 152.3, 160.4 s | 1121 MB | 11 GB | 306 pass |
| mold | 54.4, 57.4 s | 370.2, 370.2 s | 31.4, 35.0, 28.1 s | 27.2, 26.4, 26.2 s | 1087 MB (clean), 763 MB (incr.) | 11 GB | 306 pass |
| wild | 54.6, 54.2 s | 594.2, 596.3 s | 23.6, 23.7, 26.2 s | 293.5, 289.5, 293.0 s | 1072 MB | 11 GB | 306 pass |
| nightly (LLVM, LLD) | 36.3, 36.3 s | 378.8, 377.7 s | 7.9, 7.4, 8.2 s | 85.5, 85.0, 68.0 s | 1049 to 1075 MB | 3.7 GB | 306 pass |
| nightly + Cranelift | 39.4, 38.4 s | 356.4, 355.4 s | 9.0, 8.6, 8.5 s | 93.1, 91.4, 93.2 s | 968 MB | 4.0 GB | aborted (SIGABRT) |

Load average at the start of each run is in the raw log lines; the default's first run started at 4, the others between 6 and 66, and
the machine reached 100 to 200 during the mold runs because of processes outside the benchmark lock. A second, paired run alternated the
default and mold incremental builds inside one lock hold so both saw the same load:

| Paired run | Clean wall / CPU | Incremental wall (4 runs) | Incremental CPU (4 runs) |
| --- | --- | --- | --- |
| default (LLD) | 52.9 s / 497.4 s | 15.7, 19.8, 20.7, 18.2 s | 171.8, 169.9, 160.0, 166.0 s |
| mold | 62.9 s / 384.8 s | 21.4, 28.3, 27.0, 24.7 s | 26.6, 27.8, 26.9, 27.6 s |

Readings:

- **CPU time is stable and the comparison is clear.** mold needs 21 to 23 percent less CPU for a clean build and 83 percent less (about
  27 against about 165 CPU-seconds) for the incremental relink of 68 test binaries.
- **Wall time is not resolvable here.** In the paired run mold's wall time was higher while its CPU was a sixth of the default's,
  which is what a starved process looks like at load 60 to 190; the same shape appears in the clean builds. This page therefore
  claims no wall-clock gain for mold. On a quiet 24-core machine the relink difference should show in wall time; that was not
  observed.
- **wild** costs more CPU than the default in both modes and is not competitive in this setup.
- **Cranelift** compiles the crate in about the same CPU as the nightly LLVM backend (clean 356 against 378, incremental 92 against
  85), so on a test build whose time is dominated by dependencies and linking it buys nothing. The unit-test binary built with it aborts
  in `devices::idb::tests::input_runs_idb_ui_subcommands_with_point_arguments` (SIGABRT from a panic), where the same tests pass with
  LLVM. The cause was not investigated further. It would also need nightly in every place it is used.
- The nightly target directory is a third of the stable one (3.7 against 11 GB) for the same crate; that comes from the toolchain, not
  the backend, and is noted so nobody reads the Cranelift row's 4.0 GB as a backend saving.

The desktop application crate (`lazysh`, Tauri with Whisper, Parakeet and the rest, `cargo test --locked --no-run -p lazysh`, one clean run and three incremental runs
after touching `apps/client/src-tauri/src/lib.rs`, at a load of 4 to 19, so wall time is meaningful here) agrees:

| Variant | Clean wall / CPU | Incremental wall (3 runs) | Incremental CPU (3 runs) | Peak RSS | Target | Unit tests |
| --- | --- | --- | --- | --- | --- | --- |
| default (LLD) | 318.2 s / 1504.9 s | 14.6, 15.7, 15.3 s | 58.0, 61.1, 62.0 s | 3853 MB | 12 GB | 795 pass |
| mold | 255.5 s / 1249.2 s | 13.2, 13.0, 13.2 s | 16.6, 17.1, 17.0 s | 4219 MB (clean), 2256 MB (incr.) | 12 GB | 795 pass |

mold is 20 percent faster on the clean test build, 14 percent faster on the incremental one and uses 17 percent and 72 percent less CPU. Those are the gains
on this machine only; they do not change the decision below, because the cost is paid by every contributor and every job.

### Enable mold on your machine (opt-in)

Nothing in the repository selects mold. To use it for your own debug and test builds, install `mold` and add one of these
to your user-level `~/.cargo/config.toml` (Cargo concatenates `rustflags` arrays from every config file; a `RUSTFLAGS` environment variable
replaces them):

```toml
[target.x86_64-unknown-linux-gnu]
rustflags = ["-C", "link-arg=-fuse-ld=mold"]   # GCC 12.1 or newer, or Clang
```

or wrap a single command, which works with any compiler driver and needs no config: `mold -run cargo test`.
Both forms were checked on a sample crate: the binary's `.comment` section reports `mold 3.0.0` instead of `LLD`.

Keep this out of builds you publish. The user-level setting also applies to `cargo build --release` on your machine; released
artifacts come from CI, which does not read it, so the F-Droid recipe and every published artifact keep the default linker.

Why not the repository default or CI: it needs a new tool on every contributor's machine and an `apt-get install mold` on each hosted job (the
install is paid on every job, a clean agent build saves about 100 CPU-seconds, and a hosted runner has 4 vCPUs), and it does not apply to the macOS,
Windows, iOS or Android jobs. If a measured wall-clock gain on a hosted runner appears later, a CI trial belongs in its own change.

## moon task granularity and CI selection

Measured on the pull-request run 45856165676 (the one run among the latest 100 `checks` runs whose per-job timings were all
available) and on local replays.

| Finding | Number | Outcome |
| --- | --- | --- |
| The `client` job runs `client:test-e2e` (Playwright) on every pull request, whatever it changes | 2977 s of 52.3 minutes | [#2741](https://github.com/mihazs/lazysh/pull/2741): the three Playwright suites follow the `client` area of `native-changes.sh`; replay of the last 40 first-parent commits on `main` selects the client area for 28 and skips it for 12 |
| `agent` runs `check-rust` and then `lint` (clippy `--all-targets`, same features) | check then clippy 39.0, 39.8 s wall, 193.4, 196.3 CPU-s; clippy alone 23.4, 24.6 s wall, 158.5, 159.7 CPU-s on `lazysh-agent` | [#2748](https://github.com/mihazs/lazysh/pull/2748): `check-rust` left out of the `agent` job; `verdict-agent` still runs it on `main` |
| moon runs each Cargo verb once per crate | per-crate: 221.8 s wall, 999.9 CPU-s (17 GB); one cargo run per verb: 124.3 s, 832.8 CPU-s (16 GB) on the companion crates | follow-up [#2759](https://github.com/mihazs/lazysh/issues/2759) (the wall difference was measured under different load; the 17 percent CPU difference is the firm part) |
| `client-native:verify-native` depends on `^:test-rust`, `^:lint`, `^:format-check`, so `native-linux` re-runs the agent crate's checks that the `agent` job just ran | 62 tasks in the action graph for `client:build client-native:verify-native` | Left as is: `native-linux` builds on a different glibc baseline and is a required check of its own |
| Rust tasks are `cache: false` | by design (`.moon/tasks/cargo.yml`) | Left as is: their outputs are not declared and Cargo's own incremental cache (rust-cache in CI) does the work; moon's cache is restored only for the `client` job |
| Affected-area selection cost | `moon-areas.mjs` 0.63 s per path warm (1.14 s cold) | Negligible against the 1.4 minute mean of `changes` |
| Version pull requests | already select no native job ([#2299](https://github.com/mihazs/lazysh/pull/2299)) | Nothing to add |

Reproduce the replay: for each first-parent commit `c` of `main`, run `EVENT=pull_request BASE=c~1 HEAD=c sh .github/scripts/native-changes.sh` and read the
`client=` line.

## Android build

Step timings from run 45856165676 (one run; the jobs queued 25 to 131 minutes before starting, so shortening a job's run time shortens every dependent chain):

| Job | Dominant step |
| --- | --- |
| `native-android` (14.7 min) | `bun run build:android` (aarch64 debug APK) 683 s; two Gradle unit-test steps 45 s and 46 s |
| `native-android-terminal-core` (25.5 min) | arm64 debug app with the terminal core (compiled and linked, not run) 764 s; x86_64 app 441 s |
| `native-android-appium` (25.9 min) | x86_64 debug APK 638 s; instrumentation 779 s |
| `native-android-biometric`, `-zellij`, `-tmux` | one instrumentation step of 667 to 799 s, which includes the x86_64 build through `deps: [~:build-android-emulator]` |

- **ABIs.** Every build task passes one target (`--target aarch64` or `--target x86_64`), and the instrumented tasks pass
  `-PabiList=x86_64 -ParchList=x86_64 -PtargetList=x86_64 -x :app:rustBuildX86_64Debug`. A Gradle dry run of the unit-test invocation of `native-android`
  (`:tauri-plugin-lazysh-push:testDebugUnitTest :app:testUniversalDebugUnitTest :app:testUniversalReleaseUnitTest`) lists 250 tasks and none is a `rustBuild*` or JNI-merge task,
  so no test job compiles all four ABIs. Nothing to change.
- **Gradle settings.** `org.gradle.parallel` is commented out, the daemon heap is 2 GB and the configuration cache is on. Rerunning that unit-test invocation locally
  (warm dependency cache, three rounds each of `-Dorg.gradle.parallel=false` and `true`) took 2.8 to 3.2 s wall and 9 to 9.4 CPU-seconds in every round except the first (11.3 s, daemon and
  configuration cold). The tuning options cannot show a difference when the work is that small, and Gradle is under 100 s of the 14.7 minutes. Rejected.
- **The real cost is the Rust build of the APK** and the fact that about ten emulator jobs build the same x86_64 debug APK. Sharing one build is [#2760](https://github.com/mihazs/lazysh/issues/2760).
  It changes workflow structure and needs a hosted-runner measurement, so it is a follow-up, not part of this change.
- **Waydroid and the x86_64 lane** consume the same APK as the emulator jobs (`docs/architecture/waydroid-lane.md`); no change.
- **R8 and minification** are release settings and were not touched.

## Limits of these numbers

- One machine (24 threads, 31 GB), shared with other sessions: wall times are affected by load, which is why CPU time is the primary metric and the load average is
  recorded with each run. Wall-clock claims are made only where the result is large against that noise.
- The full linker matrix is one link-heavy crate (`lazysh-agent`); the desktop crate was measured for the default linker and mold only (wild and Cranelift were already rejected on the agent crate).
- CI changes were validated by running the classifier and the moon graph locally and by the existing workflow tests; the hosted runner was not exercised.
- Android timings come from one hosted run; no emulator or device was run locally for this page.
