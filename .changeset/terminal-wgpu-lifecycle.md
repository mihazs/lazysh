---
"@lazysh/client": patch
---

Teach the wgpu renderer of the native terminal engine to blink the cursor from one shared timer (no timer at all while blink is off or the cursor is hidden), pace frames to the display refresh, follow a display scale change, and recover from a lost GPU device from the core's state with the same pixels. It is not wired into the app yet and xterm.js stays the only engine and the default, so nothing changes for users; this is groundwork for trying the native engine behind an explicit opt-in.
