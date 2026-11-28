---
"@lazysh/client": minor
---

feat(agents): add custom arguments and a YOLO toggle when starting an agent in a folder

Start in a folder now takes optional arguments for Claude Code or Codex, each passed to the agent as plain text (quotes group words, nothing is expanded or run), and a YOLO toggle that adds the agent's own flag to skip its approval prompts: `--dangerously-skip-permissions` for Claude Code and `--dangerously-bypass-approvals-and-sandbox` for Codex, which also turns its sandbox off. YOLO is off every time and is never remembered, the review step shows the exact command and says what the flag does. With no arguments and YOLO off the command is unchanged.
