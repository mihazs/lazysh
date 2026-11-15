---
"@lazysh/agent": minor
---

Make `lazysh-agent update`, `update --dry-run` and `update --rollback` work on Windows: the running `lazysh-agent.exe` is renamed aside and the verified file placed under its name, with the previous copy kept for rollback.
