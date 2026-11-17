---
"@lazysh/client": patch
---

For ordinary sessions, continue the Auto transport fallback sequence when a Mosh startup fails, instead of refusing with "Mosh connection ended before startup completed": the startup error the Mosh or Eternal Terminal worker reports now wins over the cancel that follows it. Once a Mosh multiplexer entry has been started, a failed startup retains its explicit non-fallback error.
