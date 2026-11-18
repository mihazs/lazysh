---
"@lazysh/client": patch
---

Extend the Android tmux acceptance case: it now splits a window's pane top/bottom and zooms and unzooms the new pane from the Sessions panel (the tmux client's display is the witness, also after a detach and reattach), and the host checks that the original pane process is untouched. Test-only; no behaviour changes.
