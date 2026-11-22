---
"@lazysh/client": minor
---

feat(zellij): reattach saved Zellij sessions on reconnect and restore without creating or resurrecting them

Changed default: a lost Zellij tab now reconnects to the same session and **Restore previous workspace** reopens saved Zellij sessions, as it does for tmux and Herdr (#1145, part of #1138); before, restore skipped Zellij and a reconnect gave a plain host shell. The reattach runs `zellij attach <name>` without `--create` after the full session listing shows the name with a running server, so a session that no longer exists (a host restart, a kill) or that is only a serialized exited session fails with a message instead of starting an empty or resurrected one (#2047). Zellij has no attach that refuses to resurrect, so a session that exits between the listing and the attach can still be resurrected. Attaching from Sessions still creates a new session.
