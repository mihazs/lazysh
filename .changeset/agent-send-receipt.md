---
"@lazysh/client": patch
---

fix(agents): acknowledge sends promptly and show when the agent queued them

The composer acknowledges terminal submission, reports a confirmed queue entry, and refreshes the fallback transcript sooner.
