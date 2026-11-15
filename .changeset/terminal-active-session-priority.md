---
"@lazysh/client": patch
---

Serve the terminal session that has a view attached ahead of background sessions in the native terminal core's worker queue, with a bounded share for the background ones (#1339). With nine other sessions streaming, the time from a chunk arriving to the screen update being ready fell from about 100 to 320 microseconds to about 17 (plain text) and from about 1 to 2.4 milliseconds to about 0.16 (CJK and emoji) at the median on one desktop host. Nothing in the app uses the native core yet: xterm.js stays the only terminal engine and the default, and no setting or default changes.
