---
"@lazysh/client": patch
---

Add the wgpu renderer of the native terminal engine as its own crate: a glyph atlas of fixed size with least-recently-used eviction, dirty-row batching, and no frame submitted while the screen is unchanged, checked pixel for pixel against the CPU reference renderer. It is not wired into the app yet and xterm.js stays the only engine and the default, so nothing changes for users; this is groundwork for trying a native engine behind an explicit opt-in.
