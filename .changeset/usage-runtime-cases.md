---
"@lazysh/client": patch
---

test(client): cover account usage freshness, manual refresh and unknown data at runtime

A browser runtime case serves an owned account-usage report fixture and checks the rendered timestamp and stale label, a manual refresh, and that missing data stays unknown. No product behaviour changes.
