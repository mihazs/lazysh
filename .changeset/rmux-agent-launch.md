---
"@lazysh/client": patch
---

feat(rmux): accept an rmux entry in the agent launch primitive

A confirmed plan checks the agent, optionally creates a Git worktree and starts the agent's literal argv in a new rmux window of the attached session, returning the new pane's ID (#1679). Backend only: nothing in the app calls it yet, and no defaults change.
