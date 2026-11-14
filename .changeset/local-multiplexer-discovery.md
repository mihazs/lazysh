---
"@lazysh/client": patch
---

Let the native multiplexer commands (tmux, Herdr and Zellij discovery, session lists, tmux and Zellij actions and the Zellij tab list) run against a local desktop session as argument lists, with a Rust `PATH` lookup and an owner-checked `~/.local/bin` fallback for Herdr. The interface still hides these views for local sessions, and SSH sessions behave as before.
