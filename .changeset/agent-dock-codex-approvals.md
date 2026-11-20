---
"@lazysh/client": minor
---

Show Codex's permission requests in the Agent view dock on tmux. The dock lists a `PermissionRequest` hook request of the Codex agent in the pane, for the session and pane its report names, and answers it with Allow, Deny or Deny with a message, re-checking the agent, session and pane right before the decision is sent. A Codex request lists no suggested permission updates. Nothing changes unless the Codex approval hook fragment is installed.
