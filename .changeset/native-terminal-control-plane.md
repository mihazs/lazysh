---
"@lazysh/client": patch
---

Add the native terminal core's control-plane commands and their Tauri bridge: state, scrolling, a bounded window of row text, a coalesced change signal and the program's bell, directory and clipboard reports, never cell data. The commands are tested against the real core and against what xterm.js answers for the same streams. Nothing creates a native session yet, so terminal behaviour and defaults do not change; xterm.js stays the only engine.
