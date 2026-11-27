---
"@lazysh/agent": patch
---

fix(agent): stop hook failures after large file reads in Claude

The hook command rejected any event over 256 KiB, so a `Read` of a large file ended in `PostToolUse:Read hook failed: lazysh-agent: InvalidEvent` and the activity event was lost. Hook events now accept up to 32 MiB; approvals and reported history keep their smaller bound.
