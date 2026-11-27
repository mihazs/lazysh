---
"@lazysh/client": patch
---

fix(multiplexers): show the newest pane history tail when a pane's scrollback exceeds 8 MiB

Pane history for tmux, Zellij and Herdr now keeps only the newest part of the host output before it crosses the transport bound, so a wide, deep pane shows its latest 2 MiB with the truncation notice instead of failing.
