# Unbounded Android MainPipe queue

Based on the crates.io `wry` **0.57.1** release (git revision
`2446feadae623d6f2ac8d2136e3ccef3d7197e0e`, crate SHA-256
`759c50ddad0ef9913bb5496cb9d509a50433a3b78cb0238d61105526589cf0e9`).
Original MIT/Apache-2.0 licenses and notices are retained. `Cargo.lock` of the
upstream archive is dropped.

Upstream `src/android/main_pipe.rs` queues `WebViewMessage`s for the Android main
looper in `bounded(8)`. The only consumer is the main thread, and
`Activity.onCreate -> Rust.onCreate -> android_setup -> MainPipe::send` sends from
that same thread. When an activity is recreated while eight messages are still
queued, the send blocks forever: the main thread waits on itself (ANR; lazysh
issue #2313). The patch is one line: `unbounded()`. Memory stays bounded in
practice because the producers are UI-driven calls.

Removal condition: drop this vendor directory and the `[patch.crates-io]` entry
when a released wry no longer blocks the main thread on a full MainPipe queue
(check `main_pipe.rs` of each release, latest checked 0.57.3 still `bounded(8)`).

## Files removed from upstream

- `examples/custom_protocol/wasm.wasm`: a WebAssembly binary used only by an example that is never built here. The F-Droid source scanner reports any WebAssembly file as an error, which stops the verified release build (`Release gate: missing or failed candidate source scan`, v1.98.x). Nothing else is removed; `tests/vendored-binaries.test.ts` keeps binaries out of this directory.
