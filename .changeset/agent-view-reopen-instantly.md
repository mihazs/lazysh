---
"@lazysh/client": patch
---

Show the last known messages of an Agent view conversation at once when coming back to it (another agent or session and back, or after a reconnect), then replace them with the host's answer. Kept in memory only, at most 8 conversations of 100 messages, and dropped when the app locks.
