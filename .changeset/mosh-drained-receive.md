---
"@lazysh/mosh-transport": patch
---

Keep active Mosh sessions alive after an empty nonblocking receive instead of treating “No packet received: Success” as fatal.
