---
"@lazysh/client": patch
---

Split the 2,500-line `App.test.tsx` client suite into ten per-area files that share one harness, so vitest runs them in parallel and no single file holds the client check's critical path. Test-only: no application behaviour changes.
