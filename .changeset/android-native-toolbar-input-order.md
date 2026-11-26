---
"@lazysh/client": patch
---

fix(android): keep native keyboard commits ahead of toolbar keys

Toolbar Enter waits for text already committed by the Android keyboard. An armed Ctrl or Alt modifier applies to that earlier text first.
