---
"@lazysh/client": patch
---

fix(agents): open the Claude Code and OpenCode conversations that hold a large tool result

The Agent view no longer refuses a Claude Code or OpenCode session because one tool result is megabytes long: the text is cut with a note of how many bytes were left out, and a compaction link that names a later record no longer makes the session a loop. Needs the updated host companion.
