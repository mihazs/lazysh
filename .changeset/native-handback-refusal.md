---
"@lazysh/client": patch
---

fix(terminal): keep the native renderer when switching to xterm.js is refused

A terminal that already switched keeps showing live output after unlock.
