---
"@lazysh/client": patch
---

Fall back to SSH on the Auto transport when a Mosh startup fails, instead of refusing with "Mosh connection ended before startup completed": the startup error the Mosh or Eternal Terminal worker reports now wins over the cancel that follows it.
