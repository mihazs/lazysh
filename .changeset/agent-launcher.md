---
"@lazysh/client": minor
---

feat(agents): add New agent to the Agent view to start an agent in a folder, a new folder or a new worktree

Start Claude Code, Codex or another supported agent in an existing folder, a new folder (created with `mkdir -p`) or a new Git worktree without typing a command, in a new tmux window, Zellij pane or Herdr workspace of the attached session. The exact commands are shown and nothing runs until you confirm; agents missing from the host are listed as not installed.
