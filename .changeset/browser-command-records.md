---
"@lazysh/agent": patch
---

fix(agent): read complete browser relay command records

The host-browser test fixture waits for each record's newline before parsing it.
