---
"@lazysh/client": minor
---

feat(terminal): show which terminal engine the current session uses and why

The Connections page of Workspace tools and Settings, Terminal and accessibility, now say which engine draws the current session and why the app chose it: automatically, in Settings, by the developer override, or, when xterm.js stands in for the native engine, the reason the native engine was refused (a screen reader is active, or the engine cannot run in this build). In English, Brazilian Portuguese and Spanish. No default changes: sessions still use xterm.js.
