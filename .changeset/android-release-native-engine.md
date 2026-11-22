---
"@lazysh/client": patch
---

build(android): compile and package the native terminal engine in the Google release APK

The Google arm64 release APK is now built with the `native-terminal` feature, so the native terminal engine (libghostty-vt and the wgpu renderer) ships inside it. Nothing changes for users yet: release builds still refuse the native surface and Auto keeps using xterm.js, so the default terminal is the same.
