---
"@lazysh/client": patch
---

Prepare screen-reader access for a native terminal surface: a hidden, bounded mirror of the visible rows with a polite announcement log, and a rule that a session read with a screen reader never gets a terminal engine that cannot reach one. xterm.js stays the only engine and nothing offers another one yet, so terminal behaviour and defaults do not change.
