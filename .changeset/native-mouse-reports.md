---
"@lazysh/client": patch
---

feat(terminal): send mouse clicks, drags and taps to mouse-tracking programs on the native terminal

On a session using the native terminal engine, a program that tracks the mouse (for example `vim` or `htop` with mouse mode) now receives a mouse's button presses, drag motion and releases, and a finger's quick tap as clicks, in addition to wheel scrolling. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.
