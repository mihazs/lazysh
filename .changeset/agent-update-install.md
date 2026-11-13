---
"@lazysh/agent": minor
---

Add `lazysh-agent update`, `update --dry-run` and `update --rollback` for Linux and macOS hosts: the host downloads the release itself, verifies its size and SHA-256 against the release metadata, self-tests the new binary, replaces the managed companion atomically and keeps the previous one for rollback.
