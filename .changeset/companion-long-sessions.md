---
"@lazysh/agent": minor
---

Read long Claude Code sessions: `transcript --view conversation` takes a session file of up to 64 MiB and record lines of up to 4 MiB (the limits `herdr-conversation` already used) instead of 16 MiB and 256 KiB, and cuts every text block it returns at 96 KiB with a note of how many bytes were left out. The page schema is unchanged and an older companion keeps working with the old limits.
