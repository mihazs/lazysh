---
"@lazysh/client": patch
---

Add the native terminal engine's adapter (control plane only) and make it pass the terminal adapter contract suite against a stand-in core. Nothing selects it yet, so terminal behaviour and defaults do not change; xterm.js stays the only engine.
