---
"@lazysh/client": patch
---

Run the host companion commands in local sessions. The Agents board, approvals, transcripts, usage and history reads, companion settings, hook setup and notification checks now resolve a `local:` session through the host context and run `lazysh-agent` as argv on this device (beside the app, then the managed copy, then the `PATH`), without SSH or a shell. The interface still hides these views for local sessions; no default changes.
