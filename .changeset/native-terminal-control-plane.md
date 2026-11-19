---
"@lazysh/client": patch
---

Add the native terminal core's control-plane commands and event stream: state, scrolling, sizing and a bounded window of row text, never cell data, plus a change doorbell and the program's title, bell, directory and clipboard reports on the session's Channel. Nothing creates a native session yet, so terminal behaviour and defaults do not change; xterm.js stays the only engine.
