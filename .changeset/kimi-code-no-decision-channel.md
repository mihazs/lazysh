---
"@lazysh/agent": patch
---

Record that Kimi Code 2.4.1 has no hook that can carry an Allow (hooks that print an allow on `PermissionRequest` and `PreToolUse` leave the prompt waiting; `PreToolUse` can only block), so a Kimi prompt stays in the terminal, with two new scenarios in the repeatable qualification run. No behavior change.
