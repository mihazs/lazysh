---
"@lazysh/agent": patch
---

fix(agent): keep hook events the busy store refuses and record them on the next report

Under heavy load the hook ingest waited its three seconds for the store's write lock, failed with `StorageError: operation failed (sqlite_code=5)` and the event was lost. The hook still fails in that case, but the event is now kept beside the store and recorded, in order, by the next ingest.
