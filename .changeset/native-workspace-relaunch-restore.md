---
"@lazysh/client": patch
---

Add acceptance cases for restoring the previous workspace after the app is killed and relaunched: a Linux native GUI case that reattaches the same durable tmux pane only after explicit restore, and mocked relaunch cases for tmux, Herdr, Zellij and plain-shell descriptors. Test-only; restore behavior and defaults are unchanged.
