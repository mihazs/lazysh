---
"@lazysh/client": patch
---

test(terminal): isolate the native scrollback budget checks

The renderer notification test releases its core, and the budget checks count only their own terminal sessions.
