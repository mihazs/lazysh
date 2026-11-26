---
"@lazysh/client": patch
---

feat(terminal): include the native Wayland engine in Linux packages

The Linux x64 Debian package and AppImage include the native terminal when the release kill switch is on. X11 sessions continue to use xterm.js.
