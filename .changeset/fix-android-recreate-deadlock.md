---
"@lazysh/client": patch
---

fix(android): stop the app freezing when the screen is recreated

Rotating the device or changing the theme could hang the app with an "not responding" dialog while the web view still had queued updates. The queue between the app and the web view no longer has a size limit that the main thread could wait on forever.
