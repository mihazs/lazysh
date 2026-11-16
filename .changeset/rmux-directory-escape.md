---
"@lazysh/client": patch
---

Start rmux sessions, windows and split panes in a directory whose name holds `#{...}` instead of Home: rmux expands formats in a start directory, so lazysh sends such a directory with each `#` doubled.
