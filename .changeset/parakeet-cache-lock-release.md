---
"@lazysh/client": patch
---

Release the local Parakeet cache lock when its owner closes, even when a child inherited its descriptor (#2009).
