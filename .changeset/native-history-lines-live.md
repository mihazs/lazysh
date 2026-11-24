---
"@lazysh/client": patch
---

feat(terminal): the History lines setting reaches a native session that is already open

Changing History lines in Settings now changes how many rows an open native terminal keeps, as it already did for xterm.js. A smaller number drops the oldest rows at once.
