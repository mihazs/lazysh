---
"@lazysh/client": patch
---

feat(terminal): select text with the pointer on the native terminal adapter

A mouse drag, a double click (word), a triple click (line), shift-click and a touch long press now select on the native adapter's anchor. The native engine stays opt-in; xterm.js remains the default.
