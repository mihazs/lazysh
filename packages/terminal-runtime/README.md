# lazysh-terminal-runtime

Shared, UI-independent terminal runtime on Herdr's vendored libghostty-vt binding
([#1313](https://github.com/mihazs/lazysh/issues/1313), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)).
Design: [docs/architecture/terminal-runtime.md](../../docs/architecture/terminal-runtime.md). Not wired into the app.

It owns VT state for one session: bounded byte ingress with credits, incremental dirty-row frames,
snapshots for a recreated surface, UI size intent versus transport-authoritative size (including Mosh's OSC 7777 frames as a top-anchored resize without reflow, `Config::canonical_frames`), terminal
replies, key/mouse/paste encoding, text inspection (`read_rows`, `viewport`) and the control plane of [#1321](https://github.com/mihazs/lazysh/issues/1321) (`control_snapshot`, `control_scroll`, `control_resize`, `take_control_events` and the `Doorbell`: the state and the text of a bounded window of rows, never cells, and what the program reported, as the JSON the app's `terminal_core_*` commands and the stdio harness share). A `TerminalRuntime` has no transport or thread and draws nothing itself; it is `Send` (a test moves a live one to another thread) but not `Sync`.

`Hub` and `Session` ([#1315](https://github.com/mihazs/lazysh/issues/1315),
[#1316](https://github.com/mihazs/lazysh/issues/1316), [#1319](https://github.com/mihazs/lazysh/issues/1319))
are the transport-independent service on top: a fixed pool of VT worker threads owns every session's runtime,
transports call `Session::feed` and get credit back after VT processing, replies and encoded input leave through
one `PtyWriter` that applies the host's access policy, and a registry enforces a global scrollback budget with
attach/detach/close. See the "Session service" section of the design document.

## Renderer API

`TerminalRenderer` ([#1322](https://github.com/mihazs/lazysh/issues/1322), contract in
[native rendering](../../docs/architecture/native-rendering.md#terminal-renderer-api)) is what a renderer implements:
frames in, pixels on an opaque surface out, no graphics type. `Screen` is the shared dirty-row model and
`layout` decides what to paint for a row and `ReferenceRenderer` is a deterministic CPU implementation that rasterizes it. Its golden images live in `tests/golden/` and are rendered from real
libghostty-vt output; after an intended rendering change run `UPDATE_GOLDEN=1 cargo test --test renderer` and review the
PNGs as images (the test writes `<name>.actual.png` into the target directory when a golden differs).

## wgpu renderer

The production wgpu implementation is the sibling crate [`terminal-renderer-wgpu`](../terminal-renderer-wgpu/README.md) ([#1324](https://github.com/mihazs/lazysh/issues/1324)), a separate nested workspace with its own lock file so wgpu never reaches this crate, the root workspace or the integrity-checked Ghostty sources. Its tests need a GPU adapter (CI uses Mesa's software Vulkan) and run in the `herdr-native` job.

## One Ghostty dependency

`ghostty-vt` is a path dependency on `../herdr-upstream/crates/ghostty-vt`. Nothing is copied,
patched or forked, and Herdr's integrity manifest is untouched. This crate is a nested workspace
(like `herdr-upstream`) because the dependency's build script runs Zig 0.16.0; the root Cargo
workspace and default builds never need Zig.

## Build and test

Zig writes `zig-pkg/` beside the vendored `build.zig`, so build from a copy outside the checkout with
`herdr-upstream` and `terminal-runtime` as siblings, as the `herdr-native` CI job does (which also
runs these tests against the archives it admits by Zig package hash):

```sh
repo="$PWD"; root="$(mktemp -d)"; cp -a packages/herdr-upstream packages/terminal-runtime "$root"
cd "$root/terminal-runtime"
export ZIG=/path/to/zig-0.16.0 CARGO_TARGET_DIR="$root/target" \
  ZIG_LOCAL_CACHE_DIR="$root/zig-local" ZIG_GLOBAL_CACHE_DIR="$root/zig-global" \
  LAZYSH_MOSH_FIXTURE="$repo/apps/client/e2e/fixtures/mosh-resize-frames.json"
cargo +1.96.1 test --locked
cargo +1.96.1 run --release --example parse_bench   # host throughput, see docs/architecture/terminal-benchmarks.md
cargo +1.96.1 run --release --example session_bench # pooled data path, input latency, memory
cargo +1.96.1 run --release --example mosh_bench    # one Mosh display update: canonical resize plus repaint
cargo +1.96.1 run --release --example inspect_bench # text queries: Herdr's tap check, a screen read
cargo +1.96.1 run --release --example scrollback_budget # rows kept per byte budget by width and content (History lines mapping)
cargo +1.96.1 run --release --example perf_gate     # the CI regression gate (`terminal-perf` job); --inject slow|allocs must fail it
```

## Target status

Checked with `cargo check --target` from a Linux x86_64 host, Zig 0.16.0:

| Target | Result |
| --- | --- |
| `x86_64-unknown-linux-gnu` | builds, tests pass |
| `aarch64-unknown-linux-musl`, `x86_64-unknown-linux-musl` | build script and crates compile |
| `aarch64-apple-darwin` | the build script, the crates, their tests and examples compile and clippy is clean from the Linux host; on a Mac, the report-only `terminal-macos` job of `checks.yml` (pushes to `main`) builds libghostty-vt against the runner's Apple SDK with Zig 0.16.0 for Apple silicon and runs this crate's and the renderer's tests on `macos-latest`. A pull-request run of it on macOS 26.7 (Xcode 26.6, macOS 26.5 SDK) passed: [run 44387474497](https://github.com/mihazs/lazysh/actions/runs/44387474497) |
| `aarch64-apple-ios` | fails: libghostty-vt's Apple SDK package needs a macOS SDK (`pkg/apple-sdk/build.zig`), unavailable on this host |
| `x86_64-pc-windows-msvc` | fails: Zig has no MSVC libc headers here; Herdr's build accepts `LIBGHOSTTY_VT_WINDOWS_LIBC`, not provided |
| `aarch64-linux-android`, `x86_64-linux-android` | `cargo check` and a link of the library and every test executable pass, with Zig 0.16.0 and NDK r29.0.14206865 (`ANDROID_NDK_HOME`; the Rust linker is the NDK's `<triple>24-clang`, API 24 being the app's `minSdkVersion`). The binding's `build.rs` maps both triples ([#2098](https://github.com/mihazs/lazysh/issues/2098), a documented local modification in `herdr-upstream/PROVENANCE.md`), the `herdr-native` job runs them, and the vendored `libghostty-vt` build already selects the NDK with 16 KiB page alignment. The static archive is about 18 MiB per ABI in the debug profile. Linked, not run: no test has executed on Android, Waydroid or an emulator |

The iOS build belongs to [#1312](https://github.com/mihazs/lazysh/issues/1312), blocked by
[#384](https://github.com/mihazs/lazysh/issues/384); none of those checks may be relaxed to pass.
Compiling is not running: apart from the Linux host and the macOS job above, no target has executed a test.
That run found one real difference between hosts: libghostty-vt built for macOS sends no ESC prefix for Alt unless
its `macos_option_as_alt` option is set (Option composes text there), and `setopt_from_terminal` resets it, so the
runtime sets it on every key encode and an Alt it is given is Alt on every host.
