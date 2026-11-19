---
"@lazysh/client": patch
---

test(terminal): Run the terminal adapter contract suite against the real core in CI and fail on an untested capability

Part of #1305 and #1302. A test-only JSON-RPC process over stdio in the terminal runtime crate (`examples/control_stdio.rs`) calls the same session, doorbell and control-plane functions as the app's `terminal_core_*` commands, and the `herdr-native` CI job, which has Zig and Bun, runs the unchanged contract suite over it through the native terminal adapter. A guard now fails when a backend claims a capability that no passing test case verifies, and every backend registered in `terminalBackends.ts` must pass the suite and the cases of each capability it declares. No behaviour changes: the app, the terminal engines and every default are untouched, and xterm.js stays the only registered engine.
