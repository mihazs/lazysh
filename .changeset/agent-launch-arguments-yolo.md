---
"@lazysh/client": minor
---

feat(agents): add custom arguments and a YOLO toggle to New agent

New agent now takes optional arguments for the agent, each passed to it as one separate argument (never through a shell), and a YOLO toggle that adds the agent's own flag to skip its approval prompts: `--dangerously-skip-permissions` for Claude Code, `--dangerously-bypass-approvals-and-sandbox` for Codex (which also turns its sandbox off) and `--auto` for OpenCode 2.x. YOLO is off every time and is never remembered; the review step shows the exact commands and says what the flag does. Without arguments and with YOLO off nothing changes, and the launch request of an older client plans the same commands.
