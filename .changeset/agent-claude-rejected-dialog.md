---
"@lazysh/agent": patch
---

fix(agents): stop a Claude Code row waiting for approval after you reject its permission dialog

Settle a Claude Code row that waits at a permission dialog the person rejected: Claude Code sends no hook for No or Esc, so `lazysh-agent snapshot` now reads the end of the session's conversation file and marks the row done ("Turn interrupted") when its last record is the interruption marker written after the wait began. A rejection older than the wait, or anything said after it, settles nothing, and a host whose snapshot cannot find the file keeps the previous behaviour.
