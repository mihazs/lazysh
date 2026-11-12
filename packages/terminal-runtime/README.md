# lazysh-terminal-runtime

Shared, UI-independent terminal runtime on Herdr's vendored libghostty-vt binding
([#1313](https://github.com/mihazs/lazysh/issues/1313), epic [#1302](https://github.com/mihazs/lazysh/issues/1302)).
Design: [docs/architecture/terminal-runtime.md](../../docs/architecture/terminal-runtime.md). Not wired into the app.

It owns VT state for one session: bounded byte ingress with credits, incremental dirty-row frames,
snapshots for a recreated surface, UI size intent versus transport-authoritative size, terminal
replies, key/mouse/paste encoding, and text inspection. It has no transport, renderer or thread; a runtime is
`Send` (a test moves a live one to another thread) but not `Sync`.

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
root="$(mktemp -d)"; cp -a packages/herdr-upstream packages/terminal-runtime "$root"
cd "$root/terminal-runtime"
export ZIG=/path/to/zig-0.16.0 CARGO_TARGET_DIR="$root/target" \
  ZIG_LOCAL_CACHE_DIR="$root/zig-local" ZIG_GLOBAL_CACHE_DIR="$root/zig-global"
cargo +1.96.1 test --locked
cargo +1.96.1 run --release --example parse_bench   # host throughput, see docs/architecture/terminal-benchmarks.md
```

## Target status

Checked with `cargo check --target` from a Linux x86_64 host, Zig 0.16.0:

| Target | Result |
| --- | --- |
| `x86_64-unknown-linux-gnu` | builds, tests pass |
| `aarch64-unknown-linux-musl`, `x86_64-unknown-linux-musl`, `aarch64-apple-darwin` | build script and crates compile |
| `aarch64-apple-ios` | fails: libghostty-vt's Apple SDK package needs a macOS SDK (`pkg/apple-sdk/build.zig`), unavailable on this host |
| `x86_64-pc-windows-msvc` | fails: Zig has no MSVC libc headers here; Herdr's build accepts `LIBGHOSTTY_VT_WINDOWS_LIBC`, not provided |
| `aarch64-linux-android` | fails before Zig: the binding's `build.rs` has no mapping for Android triples and panics (the vendored Zig does carry Android NDK support, and no NDK is installed here) |

Android and iOS builds belong to [#1312](https://github.com/mihazs/lazysh/issues/1312), blocked by
[#384](https://github.com/mihazs/lazysh/issues/384); none of those checks may be relaxed to pass.
Compiling is not running: no target other than the Linux host has executed a test.
