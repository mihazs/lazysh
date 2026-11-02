---
"@lazysh/push-registration": patch
"@lazysh/client": patch
---

Persist the selected Android push provider before explicit controls so late Firebase cleanup markers cannot change the chosen transport after restart.
