---
"@lazysh/client": patch
---

Add the tmux and Zellij launch primitive (#1141): a confirmed plan that checks the agent, optionally creates a Git worktree and starts the agent's literal argv in a new tmux window or Zellij pane of the attached session, returning the new pane's ID. Backend only: nothing in the app calls it yet, and no defaults change.
