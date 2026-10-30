---
"@lazysh/client": patch
---

Preserve the file-transfer closure warning and its partial-file guidance when uploads need reauthentication. Distinguish host-tools SSH closure so Agents only offers command recovery for the correct connection purpose; quota reads continue to classify a closed command connection as disconnected.
