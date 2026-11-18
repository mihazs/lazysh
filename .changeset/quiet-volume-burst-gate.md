---
"@lazysh/agent": patch
---

Stop the sixteen-writer storage burst cases from failing the Windows release build on a runner whose disk flushes are momentarily slow (#2114, same family as #36): each burst now waits for the temporary volume to commit fast enough for sixteen serialized durable writes, or fails explicitly after two minutes. Companion storage, `synchronous=FULL` durability and the three-second wait budget are unchanged, so nothing changes for users.
