---
"@lazysh/agent": minor
---

feat(agents): name each reported session from its first prompt so sessions in one folder are easy to tell apart

The companion now keeps one line per session, cut from the first prompt the agent reports (Claude Code, Codex, Droid, Kimi, Grok Build, Copilot, Gemini CLI and Cursor), and reports it as `title` in the snapshot. The title is at most 80 characters, with whitespace collapsed and control characters removed; a bare slash command gives none. The first prompt names the session once and later prompts never replace it; an agent that reports its own `title` through the generic event replaces it.

Changed default: this is the first prompt text the companion stores. Only that bounded line is kept; the rest of a prompt, tool arguments and transcript paths are still discarded, and the push notification relay still carries no text. A companion without a title omits the field, so older apps keep showing the folder and agent.
