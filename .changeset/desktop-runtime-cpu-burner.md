---
"@lazysh/client": patch
---

Make the tree-sample CPU test deterministic: its burner no longer spends more system time on clock reads than the 300 ms of user time it is meant to burn, which made the required `client` check fail on loaded runners. Test-only; no behaviour changes.
