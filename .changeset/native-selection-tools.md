---
"@lazysh/client": patch
---

feat(terminal): clear the selection when you type on the native terminal

On a session using the native terminal engine, typing, pasting or pressing a key now clears the selection, as it does with xterm.js. The selection handles and the Copy and Select all actions work over the native engine the same way. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.
