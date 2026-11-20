---
"@lazysh/client": patch
---

test(android): read the system clipboard after Copy of a terminal selection

Add an Android instrumentation case that long-presses a word in an owned SSH terminal, taps Copy in the selection actions and reads the system `ClipboardManager`, which must hold exactly that word and must not hold it before Copy. Test coverage only; no app behaviour changes.
