---
"@lazysh/client": minor
---

feat(agents): label each file update card as created, edited, deleted or renamed

Patch-style edits (Codex `apply_patch`, OpenCode `patch`) now show deleted and renamed files with their operation and old and new paths, and a Write says whether it created the file.
