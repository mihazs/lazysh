---
"@lazysh/client": patch
---

feat(terminal): register the native backend behind a probe that no release build passes

Register the native terminal backend in the engine registry behind a probe, the developer override and recorded reasons (#1309, part of #1302). The new `terminal_core_available` command says whether this build has the native core compiled in and a platform host to draw it on (Android only so far); the Native choice and the developer override `lazysh.terminal.backend=native` select the native engine only when it says yes, and otherwise the session uses xterm.js and records the reason. Auto still picks xterm.js, and a screen reader still refuses the native engine. No release build passes the probe, so nothing changes for users; no default changes.
