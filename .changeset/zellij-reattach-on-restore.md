---
"@lazysh/client": minor
---

Reattach Zellij sessions on reconnect and restore (#1145, part of #1138). Changed default: a lost Zellij tab now reconnects to the same session and **Restore previous workspace** reopens saved Zellij sessions, as it does for tmux and Herdr; before, restore skipped Zellij and a reconnect gave a plain host shell. The reattach runs `zellij attach <name>` without `--create` after confirming the name is listed, so a session that no longer exists (a host restart, a kill) fails with a message instead of silently starting an empty one. Attaching from Sessions still creates a new session.
