---
"@lazysh/agent": minor
"@lazysh/client": minor
---

Show plan, question and turn-state cards in native Chat. The companion projects recorded Claude Code `TodoWrite`, `AskUserQuestion` and `ExitPlanMode` calls, Codex `update_plan`, `request_user_input` and plan-mode items, and OpenCode `todowrite` and `question` parts into display-only cards. Conversation views for Claude Code, Codex and OpenCode V1 report a working, waiting, idle or stopped turn derived from recorded lifecycle records; anything else stays unknown. Question cards list the options and send the user to the terminal to answer, because Chat cannot choose options in an agent prompt. Existing tool cards, cursors and prompt targets are unchanged.
