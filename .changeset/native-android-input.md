---
"@lazysh/client": patch
---

feat(terminal): type into a native terminal session on Android

On a build where the native terminal engine is selected, the Android keyboard's editor is created with the session's surface: committed text, special keys and modifiers reach the core once and in order, and the text an input method is still composing is drawn at the cursor until it is committed. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.
