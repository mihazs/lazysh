---
"@lazysh/client": patch
---

Fix the Windows companion test run: the Codex session history test built its rollout path with a multi-segment join, so its expected path mixed `/` and `\` and never equalled the listing's path, and `native-desktop (windows-latest)` kept failing on `main` at the companion storage step. The fixture now joins one component at a time. Test-only; the history listing itself is unchanged.
