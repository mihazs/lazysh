---
"@lazysh/client": patch
---

Check a local multiplexer attach before its terminal starts: the tool must answer its version command and the named tmux, Zellij or Herdr session must exist unless it is created. A missing tool or session is refused with the same message as over SSH, and a Herdr in the owner-checked `~/.local/bin` starts when it is not on the `PATH`. The interface does not offer a local attach yet.
