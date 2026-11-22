---
"@lazysh/client": patch
---

fix(voice): release the local Parakeet cache lock when its owner closes

A child process that inherited the lock's descriptor no longer keeps the cache unavailable after its owner exits (#2009).
