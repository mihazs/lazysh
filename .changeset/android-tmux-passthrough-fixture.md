---
"@lazysh/client": patch
---

test(android): let the owned tmux fixture forward a DCS-wrapped OSC 52 to its attached client

The pinned server starts with `allow-passthrough on` (tmux 3.3 or later is now required) and the beta window is an interactive shell, so a test can print the sequence there. A host test attaches a real client and sees the unwrapped request. Test fixture only; no app behaviour changes (#1546).
