---
"@lazysh/client": patch
---

fix(agents): open long Claude Code conversations in the Agent view and page back through them

A Claude Code transcript over 16 MiB (64 MiB when Herdr selects it) no longer reports "too large to open here". The companion reads the newest page and then the older or newer ones from a bounded part of the file, keeps the queued prompts and session state, and cuts a block over 256 KiB with a note instead of refusing the conversation.
