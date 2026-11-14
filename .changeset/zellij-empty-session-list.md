---
"@lazysh/client": patch
---

Fix **Sessions** showing a command error for a host that has Zellij but no session (#1145). Zellij prints "No active zellij sessions found." and exits 1 when none is left, which lazysh read as a failure; the list now says "No running zellij sessions." and offers to create one. The same listing, which also names exited sessions Zellij can resurrect, is used before a saved Zellij entry attaches. Any other failure, such as Zellij missing from the host, is still an error.
