---
"@lazysh/client": patch
---

Keep Agents results, counts and empty states stable during periodic refreshes. Preserve read failures until a replacement completes; a failed live read clears its rows and count. This fixes polling flicker without claiming that the reported missing Herdr agents are resolved.
