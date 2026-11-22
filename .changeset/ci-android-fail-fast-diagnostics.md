---
"@lazysh/client": patch
---

ci(android): keep the app's thread dump and ANR traces and the tmux server's own log for a failed Android run

A blocked case or a tmux server that exits uncleanly left no trace of where it stopped. A failed run now captures the app's thread dump and ANR traces into the system diagnostics, and the tmux fixture's server logs into the tmux results. CI only. No user-visible behaviour changes.
