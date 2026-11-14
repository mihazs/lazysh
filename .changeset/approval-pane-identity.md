---
"@lazysh/agent": minor
"@lazysh/client": patch
---

Bind a remote approval to the exact Zellij or Herdr pane its hook runs in: the request carries `zellij:<session>:<pane>` or `herdr:<session>:<pane id>` in its hash and decision, and any other pane, session or multiplexer is refused.
