---
"@lazysh/agent": patch
---

Initialize companion schema tables and indexes in one deferred transaction, retaining full durability and existing storage wait budgets while rolling back partial schema creation on failure.
