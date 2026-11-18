---
"@lazysh/client": patch
---

Build and test the shared terminal core and its wgpu renderer on Windows (#1332, part of #1302): a `terminal-windows` CI job on `windows-latest` compiles libghostty-vt with Zig 0.16.0 for `x86_64-pc-windows-msvc` against the runner's MSVC and Windows SDK headers (`LIBGHOSTTY_VT_WINDOWS_LIBC`), runs the runtime crate's tests, and runs the renderer crate's tests on Direct3D 12 with the WARP software adapter. Build and CI only; the app does not use the core yet, no Windows surface exists, and xterm.js stays the only engine.
