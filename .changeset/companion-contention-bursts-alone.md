---
"@lazysh/agent": patch
---

Fix intermittent Windows release failures in the companion storage contention cases (SQLite code 5 at `ingest_begin`). Each sixteen-writer burst now runs alone instead of beside other companion runs in the same test process, and a Linux check replays the CLI suite beside a simulated slow shared volume. Companion storage, FULL durability and the 3-second wait budget are unchanged.
