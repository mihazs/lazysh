# lazysh-terminal-runtime

Shared, UI-independent terminal runtime on Herdr's vendored libghostty-vt binding
([#1313](https://github.com/mihazs/lazysh/issues/1313), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)).
Design: [docs/architecture/terminal-runtime.md](../../docs/architecture/terminal-runtime.md). Not wired into the app.

It owns VT state for one session: bounded byte ingress with credits, incremental dirty-row frames,
snapshots for a recreated surface, UI size intent versus transport-authoritative size (including Mosh's OSC 7777 frames as a top-anchored resize without reflow, `Config::canonical_frames`), terminal
replies, key/mouse/paste encoding, and text inspection. A `TerminalRuntime` has no transport or thread and draws nothing itself; it is `Send` (a test moves a live one to another thread) but not `Sync`.

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

## Prototypes

`prototypes/wgpu` is a throwaway wgpu implementation of `TerminalRenderer` for the renderer shootout ([#1323](https://github.com/mihazs/lazysh/issues/1323)); it is a separate nested workspace with its own lock file so wgpu never reaches this crate, the root workspace or the integrity-checked Ghostty sources. It needs a GPU adapter to run its tests; CI only checks that it compiles and lints (the `herdr-native` job). See the "wgpu prototype" section of [terminal benchmarks](../../docs/architecture/terminal-benchmarks.md).

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
cargo +1.96.1 run --release --example perf_gate     # the CI regression gate (`terminal-perf` job); --inject slow|allocs must fail it
```

## Target status

Checked with `cargo check --target` from a Linux x86_64 host, Zig 0.16.0:

| Target | Result |
| --- | --- |
| `x86_64-unknown-linux-gnu` | builds, tests pass |
| `aarch64-unknown-linux-musl`, `x86_64-unknown-linux-musl`, `aarch64-apple-darwin` | build script and crates compile |
| `aarch64-apple-ios` | fails: libghostty-vt's Apple SDK package needs a macOS SDK (`pkg/apple-sdk/build.zig`), unavailable on this host |
| `x86_64-pc-windows-msvc` | fails: Zig has no MSVC libc headers here; Herdr's build accepts `LIBGHOSTTY_VT_WINDOWS_LIBC`, not provided |
| `aarch64-linux-android` | fails before Zig: the binding's `build.rs` has no mapping for Android triples and panics (`unsupported target for libghostty-vt build`). Probe, not in the repo: with NDK r29 in `ANDROID_NDK_HOME`, the vendored `zig build -Demit-lib-vt -Dtarget=aarch64-linux-android` produced an aarch64 ELF with 16 KiB segment alignment, and `cargo check --target aarch64-linux-android` of this crate passed once a one-line triple mapping was added to a private copy of `build.rs`. Nothing was linked or run on Android |

Android and iOS builds belong to [#1312](https://github.com/mihazs/lazysh/issues/1312), blocked by
[#384](https://github.com/mihazs/lazysh/issues/384); none of those checks may be relaxed to pass.
Compiling is not running: no target other than the Linux host has executed a test.
