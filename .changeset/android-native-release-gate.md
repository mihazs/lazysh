---
"@lazysh/client": minor
---

feat(android): native terminal engine selectable in release builds

Release builds no longer refuse the native terminal surface: Settings > Terminal engine can select Native when the device probe passes. Auto still uses xterm.js, so the default terminal is unchanged, and a build made with `LAZYSH_NATIVE_TERMINAL=off` still refuses it.
