---
"@lazysh/client": patch
---

Build the shared terminal runtime for Android arm64 and x86_64 (#2098, part of #1312 and #1302): the Herdr binding's build script maps `aarch64-linux-android` and `x86_64-linux-android` to the Zig targets of libghostty-vt, and CI checks and links the runtime for both ABIs with the pinned NDK. Build and CI only; nothing runs on Android, the app does not use the runtime yet, and xterm.js stays the only engine.
