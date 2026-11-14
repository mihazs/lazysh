---
"@lazysh/client": minor
---

feat(multiplexers): close, rename and resize tmux panes and close sessions from the Workspaces panel

Each pane row shows its size and title and gains Rename, four divider arrows and Close, and each session gains Close session. Closing asks first with a confirmation that names the pane or session and sends one exact-id command only when confirmed. tmux reuses `$0` and `%0` after a server restart, so these four actions carry the identity of the tmux server the list was read from and tmux refuses them on a replaced server instead of acting on its same-numbered pane (#2044). No defaults change.
