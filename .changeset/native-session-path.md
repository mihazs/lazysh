---
"@lazysh/client": patch
---

feat(terminal): run a session on the native data path when the registry picks native

When the terminal engine registry selects native, the session's transport (SSH, Eternal Terminal, multiplexer attach or local terminal) now starts on the native core's own channel, so its output is parsed in Rust and never passes through JavaScript, no output credit is returned from the WebView, and closing the session closes the core. A Mosh session is not supported on native yet. Native stays off by default (it is never picked automatically), so nothing changes unless Settings, Terminal engine is set to Native on a build that has the core.
