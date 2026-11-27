---
"@lazysh/client": patch
---

test(android): close a tmux pane and a session through the real Android UI

The Android tmux acceptance case now also closes the split pane and creates and closes a second session from the Workspaces panel, each behind its confirmation, and the host checks that its own tmux tree showed that session, then none beyond the original, and the pane gone with both original panes still running. Test-only; no behaviour changes.
