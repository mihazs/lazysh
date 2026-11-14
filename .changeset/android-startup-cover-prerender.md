---
"@lazysh/client": patch
---

Keep the Android startup cover over a rendering WebView until its first frame is painted, so the app no longer flashes the page's earlier placeholder frame after the cover leaves. The WebView stays inert behind the cover and a 300 ms limit keeps the app from ever staying covered.
