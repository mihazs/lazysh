---
"@lazysh/client": patch
---

Mount a native terminal session through its anchor: the terminal pane attaches a native adapter to its container, places the Android native surface on it through the anchor tracker and takes it down when the pane is hidden or ends, and while a surface is shown every ancestor of the container stops painting its background so the surface below the page is visible, with the composer and other overlays above it. An xterm.js pane is unchanged. No backend registration gives a session a native terminal and release builds refuse the surface commands, so xterm.js stays the only engine and the default and nothing changes for users.
