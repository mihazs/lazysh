# Rust build graph audit

Audit of what the Rust workspace's dependency graph costs to compile, run for epic [#2736](https://github.com/mihazs/lazysh/issues/2736) by [#2738](https://github.com/mihazs/lazysh/issues/2738). Every number below was measured on one machine (24 threads, shared with other build jobs) from a clean target directory with `cargo build --timings`, commit `dd8397c8` unless a row says otherwise. Production behaviour, release profiles and the supply-chain gates are out of scope and unchanged.

## How the numbers were taken

- One timing-sensitive run at a time, serialised with `flock`, each in its own `CARGO_TARGET_DIR`, run as `cargo test -p <package> --no-run --locked --timings` (debug profile, `cargo` 1.99.0).
- CPU time and peak RSS come from the run's cgroup (`cpu.stat` user plus system, `memory.peak`). Unit counts and per-unit durations come from the `--timings` report.
- **Wall time is not comparable between runs**: the machine carried other jobs, and the load average is recorded with every result. Compare CPU time, unit counts and target size; use wall time only as a magnitude.

| Run | Load before | Wall | CPU (user + system) | Peak RSS | Target dir | Units |
| --- | --- | --- | --- | --- | --- | --- |
| `lazysh-agent` tests, clean | 20.8 | 46.5 s | 383.6 + 86.7 = 470 s | 9.7 GB | 11 GB | 431 |
| `lazysh` lib tests, clean (before) | 26.2 | 208.4 s | 1,048.3 + 138.5 = 1,187 s | 6.0 GB | 7.4 GB | 888 |
| `lazysh` lib tests, clean (after finding 1) | 9.9 | 206.1 s | 981.7 + 136.9 = 1,119 s | 5.8 GB | 7.3 GB | 881 |

## Findings

| # | Finding | Measured cost | Decision |
| --- | --- | --- | --- |
| 1 | The client's dev-dependency `tokio-rustls = "0.26"` kept its default `aws_lc_rs` feature, so `aws-lc-rs`, `aws-lc-sys` (a C and assembly build) and `jobserver` were compiled for tests only. Production already uses `ring` everywhere. | `aws-lc-sys` build script 25.9 CPU-s plus about 3 CPU-s of Rust units: 68 CPU-s (5.8 %) and 7 units less in the clean `lazysh` lib test build; 3 packages and 38 lock lines removed. Wall time did not move (206 vs 208 s), because the critical path is finding 2. | **Done.** `tokio-rustls` takes `ring` and `tls12` like the other crates, and the test TLS front uses the `ring` provider. The 14 `share::` tests that drive it pass. No production graph changes (`cargo tree -e normal,build` never contained `aws-lc`). Fewer C toolchain steps also helps the F-Droid from-source recipe. |
| 2 | The critical path of the client's lib tests is native code, not Rust: the `lazysh-parakeet-runtime` build script (CMake, sherpa-onnx) runs 129 s and `lazysh_lib` cannot start until it finishes, then compiles for 57 s. Whisper's build script is another 35.5 s, `lazysh-mosh-transport` (OpenSSL) 10 s, SQLite 9 s. | 98 build-script runs total 218 CPU-s of 961; 129 s of the 208 s wall time is one script. | **Not changed here.** Skipping Parakeet and Whisper in dev and test builds is the lightweight-features work of [#2740](https://github.com/mihazs/lazysh/issues/2740); caching the C builds is [#2742](https://github.com/mihazs/lazysh/issues/2742). |
| 3 | Duplicate crate versions: 55 extra versions in the client test build, 27 in the agent test build. | 36.8 CPU-s of 961 (3.8 %) and 16.8 of 518 (3.2 %). Largest: `syn` 1/2/3 (6.3), `toml_edit` 0.19/0.20/0.25 (6.1), `num-bigint` (2.2), `toml` (2.0), `nix` 0.28/0.31 (2.0), `winnow` (1.9). | **Not changed.** Almost all are owned upstream: `syn` 1, `toml_edit` 0.19/0.20, `toml` 0.8, `winnow` 0.5, `heck` 0.4 and `proc-macro-crate` 1/2 come from gtk-rs 0.18 through `tauri`/`wry`; the two RustCrypto generations (`digest`, `sha2`, `rand_core`, `der`, `curve25519-dalek`, ...) split `russh` 0.64 and `ai-usagebar-core` (new) from `age` 0.11, `web-push`, `jwt-simple` and `keyring` (old); `fluent`/`i18n-embed` bring `thiserror` 1 and `toml` 0.5. No compatible bump removes them. The one in-repo cause, `nix` 0.28 in `packages/portable-pty-vendor` (2.0 CPU-s), is not worth touching vendored PTY code for. Revisit when `age`, `web-push` and gtk-rs release on the new generation. |
| 4 | Unused direct dependencies. `cargo machete --with-metadata` and `-W unused-crate-dependencies` over every lib and bin (no `cfg` target the host cannot build). | The only real hits are four dev-dependencies of `lazysh-agent`: `hyper-util`, `rcgen`, `rustls`, `tokio-rustls`. Removing them changes no compiled unit, because `lazysh-companion-release/test-support` enables the same crates. The other `machete` reports (`tauri-plugin`, `tauri-build`, `cc`, `cmake`, `openssl-src`, `pkg-config`, `sha2` in build scripts) are false positives: they are used from `build.rs` or from `#[path]` modules. | **Not changed.** Removing them is manifest hygiene with zero build-cost change, so it does not meet this audit's bar; the audit lists them so a later cleanup does not claim a speed-up. |
| 5 | Feature unification. Checked the heavy shared crates (`tauri`, `tokio`, `reqwest`, `image`, `russh`, `age`, `whisper-rs`, `rusqlite`) with `cargo tree -e features -i`. | `reqwest`, `russh`, `image`, `age` and `whisper-rs` already use `default-features = false`. `moxcms` (8.6 CPU-s) is a mandatory dependency of `image`. `tauri` default features (`compression`, `wry`, `x11`, `dynamic-acl`) are product features: dropping `compression` would grow the embedded assets. | **Rejected**, nothing to trim without a behaviour or size change. |
| 6 | The client library is built as `staticlib`, `cdylib` and `rlib` (needed by Android and iOS). | A rebuild of the lib after a touch takes 28.6 and 29.2 s with all three types (48 CPU-s, 5.9 GB peak RSS) and 27.7 and 26.2 s as `rlib` only (41 CPU-s, 2.5 GB). The three artifacts are 1.47 GB (`.a`), 443 MB (`.so`) and 337 MB (`.rlib`). | **Rejected.** Saves about 2 s wall and 1.8 GB of disk per profile, and `crate-type` cannot be conditional on the target, so it would need a per-platform manifest. `cargo test` and `cargo check` already build neither. |
| 7 | One 99,403-line client crate. Only 25,160 lines (25 %) are in files that never mention `tauri`. | `lazysh_lib` tests are 57.4 s of rustc after the whole Tauri stack (156 CPU-s of 961) is built; the plain `lazysh-agent` crate needs 263 packages against 822. | **Follow-up** [#2743](https://github.com/mihazs/lazysh/issues/2743): extract the multiplexer, herdr, zellij and tmux protocol code (about 8,500 lines, 18 `tauri` mentions) into a plain crate first. Not done here: it is a refactor across `ssh.rs`-sized modules, not a mechanical cut. |
| 8 | The agent has 62 integration test binaries. | 62 test units are 283 CPU-s of 518 (55 %); each links a 100 to 200 MB debug executable (87 s of the 470 CPU-s is kernel time). | **Follow-up** [#2744](https://github.com/mihazs/lazysh/issues/2744): consolidation changes test isolation and the test names CI lists, so it needs its own measurement after the linker and dev-profile work ([#2739](https://github.com/mihazs/lazysh/issues/2739), [#2740](https://github.com/mihazs/lazysh/issues/2740)). |
| 9 | `cargo deny` and `cargo audit`. | No `deny.toml` or audit step exists in the repository, so there is no gate to protect. Finding 1 removes three packages and adds none; licences and advisories can only shrink. | Recorded for the record. |

## Not measured

- Windows, macOS, Android and iOS graphs: only the host (Linux x86_64) was built. Their target-specific dependencies were checked with `cargo tree` only.
- Release-profile builds: LTO and codegen units belong to [#2737](https://github.com/mihazs/lazysh/issues/2737).
- Warm and incremental rebuilds, except finding 6.

## Reproduce

```sh
export CARGO_TARGET_DIR=/path/to/a/private/target
cargo test -p lazysh-agent --no-run --locked --timings
cargo test -p lazysh --lib --no-run --locked --timings
# per-unit data: the UNIT_DATA array in $CARGO_TARGET_DIR/cargo-timings/cargo-timing.html
cargo tree -p lazysh -e normal,build,dev -d            # duplicates
cargo tree -p lazysh -e features -i <crate>            # who enables which feature
RUSTC_WORKSPACE_WRAPPER=<script that adds -W unused-crate-dependencies> cargo check --workspace --lib --bins
```
