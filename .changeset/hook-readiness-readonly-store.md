---
"@lazysh/client": patch
---

fix(hooks): read the companion store for hook readiness without creating, changing or deleting its files

`lazysh-agent hooks status` now opens the event store through a read-only SQLite file system layer, so a status read can no longer create the write-ahead index or delete the log of an empty database, even if another process removes a file while it reads. An unreadable store still reports `notChecked`.
