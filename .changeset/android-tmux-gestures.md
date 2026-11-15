---
"@lazysh/client": patch
---

Extend the Android tmux acceptance case with real two-finger gestures: a pinch out and a pinch in on the attached tmux display zoom and unzoom the pane the split added, and a two-finger swipe left and right select the next and the previous window. The host reads the active window and `#{window_zoomed_flag}` back from the tmux server and requires them to change in exactly that order. Test-only; no behaviour changes.
