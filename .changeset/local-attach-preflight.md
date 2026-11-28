---
"@lazysh/client": patch
---

feat(multiplexers): check a local multiplexer attach before its terminal starts

A local attach now needs its tool to answer its version command and the named tmux, Zellij or Herdr session to exist unless it is created. A missing tool or session is refused with the same message as over SSH, and a Herdr in the owner-checked `~/.local/bin` starts when it is not on the `PATH`. The interface does not offer a local attach yet.
