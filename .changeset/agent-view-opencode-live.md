---
"@lazysh/client": minor
"@lazysh/agent": minor
---

Stream an OpenCode session into the Agent view instead of polling it. `lazysh-agent transcript-watch` now takes `--agent opencode --path DATABASE --database-session ID` and watches the database together with its write-ahead log, where OpenCode's newest rows sit until a checkpoint, so a reply that grows or a tool result that lands reaches the view within a second. The view opens the same live channel for an OpenCode pane as for Claude Code and Codex, and falls back to polling when the host companion is older.
