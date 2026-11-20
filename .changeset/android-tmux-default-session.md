---
"@lazysh/client": patch
---

test(android): verify the saved tmux create-if-missing default through the real host editor

Verify the saved tmux create-if-missing default on Android: a second host whose Default multiplexer is tmux creates and attaches a session the server lacks through the real host editor and connect flow, and connecting again attaches the same session. Test and documentation only. No user-visible behaviour changes.
