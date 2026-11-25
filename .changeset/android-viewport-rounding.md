---
"@lazysh/client": patch
---

test(android): allow WebView rounding in keyboard viewport checks

The instrumented check accepts numeric jitter at a visible edge and still rejects actual clipping.
