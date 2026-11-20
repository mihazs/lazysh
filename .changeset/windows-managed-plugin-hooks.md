---
"@lazysh/agent": minor
---

Set up the OpenCode, Cline and Amp hook plugins on Windows hosts: `lazysh-agent hooks status`, `install` and `remove` now work there for those three providers, with owner SID, DACL, reparse-point, hard-link and stream-name admission and a replacement-race-safe commit, instead of reporting managed setup unsupported. The other providers stay preview-only on Windows.
