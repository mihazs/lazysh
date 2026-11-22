---
"@lazysh/client": patch
---

feat(terminal): send wheel reports to mouse-tracking programs on the native terminal

A finger or wheel scroll over a program that tracks the mouse (for example `less` or `vim` with mouse mode) now sends it wheel reports from the native terminal engine instead of doing nothing, as xterm.js does. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.
