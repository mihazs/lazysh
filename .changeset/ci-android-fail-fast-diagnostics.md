---
"@lazysh/client": patch
---

ci(android): end a stalled instrumentation step in 60 minutes and keep thread dumps and tmux logs for a failed run

A case that blocked held the job until its 75 minute limit, which discards the artifacts. The instrumentation step now ends at 60 minutes, and a failed run keeps the app's thread dump and ANR traces and the tmux server's own log. CI only. No user-visible behaviour changes.
