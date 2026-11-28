---
"@lazysh/agent": patch
---

fix(agent): report and retire a legacy lazysh hook that runs beside the managed one

A leftover `lazysh-agent ingest` hook at another path ingested every event a second time into the same store, doubling write contention, and an older companion rejected newer events. `hooks status` now lists these in `legacyDuplicates` and `hooks install` removes exactly them, leaving every other hook untouched.
