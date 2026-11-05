---
"@lazysh/agent": patch
---

Fix companion hook events failing on Windows with SQLite code 5 when many hooks open the store at once. Opening an initialized store now holds the bootstrap lock shared, so warm opens no longer queue behind each other or behind durable commits; only creating or upgrading the store takes it exclusively. WAL mode, FULL durability, sidecar checks and the 3-second wait budget are unchanged.
