---
"@lazysh/agent": patch
---

fix(agents): stop a Claude Code row reporting a running turn after you interrupt it with Esc

Claude Code sends no hook when the person interrupts a running turn, so the row stayed at working until the next prompt. `lazysh-agent snapshot` now reads the end of the session's conversation file for each working Claude Code row and marks it done ("Turn interrupted") when the last main-thread record is the interruption marker written after the row's last report. A newer prompt or tool call, a sub-agent's records and a marker older than the last report settle nothing.
