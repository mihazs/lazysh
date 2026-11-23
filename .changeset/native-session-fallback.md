---
"@lazysh/client": patch
---

feat(terminal): Start on xterm.js when a native session cannot start, and move a native session to xterm.js

Part of #1342 and #2092. Only an explicit Native choice reaches the native engine today, and nothing changes for Auto or xterm.js. A native session that fails to start now begins on xterm.js and the engine line says why; the failure is remembered on the device, so Auto keeps away from the native engine until lazysh is updated, and choosing Native in Settings tries it again. A native session has a new Workspace tools action, "Switch this session to xterm.js", which carries the screen, cursor and modes over (scrollback is not carried over); a session whose surface cannot be placed switches on its own.

Not tried on an Android device.
