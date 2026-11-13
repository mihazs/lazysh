---
"@lazysh/client": patch
---

Check the native terminal core's data path against real servers in CI: a real OpenSSH server, the official mosh-server and the official Eternal Terminal server. A deterministic workload through a real PTY reaches a core byte-exact and in order (Mosh: its final screen arrives) with at most one credit window queued and no output message on the WebView channel. No user-visible change: the native terminal engine is not exposed in settings yet and xterm.js stays the only terminal.
