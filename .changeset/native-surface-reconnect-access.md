---
"@lazysh/client": patch
---

fix(android): keep the native terminal active after reconnecting from a recreated Activity

Fresh native sessions use the replacement renderer's current access lease for surface and keyboard requests.
