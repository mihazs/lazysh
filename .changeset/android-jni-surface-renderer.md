---
"@lazysh/client": patch
---

feat(android): draw the native session on the surface host through a JNI renderer client

The Android surface host now hands each surface to the Rust renderer host through JNI, which draws the session's native core with wgpu and re-attaches it from a snapshot after stop and start, falling back to the pane background when it cannot draw. Only builds with the native terminal feature have the renderer; nothing selects the native engine yet, so terminal behaviour and defaults do not change.
