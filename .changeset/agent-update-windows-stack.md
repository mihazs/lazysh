---
"@lazysh/agent": patch
---

Give the Windows companion an 8 MiB main-thread stack so `lazysh-agent update`, `update --dry-run` and `update --rollback` no longer crash with a stack overflow (exit 0xC00000FD) while they download, verify and replace the running companion.
