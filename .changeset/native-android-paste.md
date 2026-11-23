---
"@lazysh/client": patch
---

feat(terminal): paste into a native terminal session on Android from the keyboard or a hardware keyboard

On a session using the native terminal engine, the keyboard's clipboard strip, Shift+Insert and Ctrl+Shift+V now paste the clipboard as one paste, so a program that enabled bracketed paste receives it as such, instead of the text arriving as typed. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.
