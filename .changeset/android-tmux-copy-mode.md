---
"@lazysh/client": patch
---

Extend the Android tmux acceptance case: through the real UI it now enters copy mode from the tmux prefix shortcut, selects and copies the pane's marker line with native keys, and requires the line to reach the system clipboard only after a real tap on Allow in the terminal's clipboard request. The host checks that the pane entered and left copy mode and that tmux's own buffer is that line. Test-only; no behaviour changes.
