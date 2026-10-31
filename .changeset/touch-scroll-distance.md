---
"@lazysh/client": patch
---

Normalize mouse-tracking touch scroll by finger travel instead of event frequency, retaining partial distance, original targeting and bounded wheel batches until the gesture ends. Keep the outer terminal canvas anchored during keyboard-sized resize and input visibility requests. Plain terminal history and physical wheel behavior remain unchanged.
