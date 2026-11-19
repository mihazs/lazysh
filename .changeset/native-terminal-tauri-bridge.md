---
"@lazysh/client": patch
---

Add the client's bridge over the native terminal core's commands: it opens a core, hands the transport the Channel the core's reports arrive on, pulls the screen's state at most once per 16 ms however much output arrives, sends typed text and pastes, drops input while the app is locked and wakes the core again after the unlock. Nothing registers the native engine yet, so terminal behaviour and defaults do not change; xterm.js stays the only engine.
