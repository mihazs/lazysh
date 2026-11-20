---
"@lazysh/client": patch
---

build(terminal): Compile the wgpu renderer into the app with the optional native-terminal feature

Part of #2201 and #1302. The app now depends on `lazysh-terminal-renderer-wgpu` by path, only with the `native-terminal` feature, and the root `Cargo.lock` pins wgpu 30.0.2 and the 37 other crates it brings. Build-only: nothing in the app calls the renderer yet, the feature stays off in every released build, default builds compile no wgpu (the `native-terminal-bridge` job checks that) and xterm.js stays the only engine a user can run.
