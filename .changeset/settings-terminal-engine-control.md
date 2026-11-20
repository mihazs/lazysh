---
"@lazysh/client": minor
---

feat(settings): add the Terminal engine control with Auto, Native and xterm.js to Settings

Settings, Terminal and accessibility, now has a Terminal engine choice on every platform (#2092, part of #1302): Auto, Native or xterm.js, in English, Brazilian Portuguese and Spanish, reachable with the keyboard like the other choices there. It sets the engine of sessions you open from now on; a session that is already open keeps its engine. The choice is stored on this device only and is never part of encrypted sync. Native is never hidden: while the engine registry refuses it (this platform has no native surface yet or its probe fails, or a screen reader is active and the native engine cannot be read by it) Native is disabled and Settings shows the registry's reason beside it. No release build passes the native probe yet, so Native is disabled everywhere, Auto still uses xterm.js and nothing changes for users; no default changes.
