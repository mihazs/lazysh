---
"@lazysh/client": patch
---

Map the History lines setting to the byte budget of the native terminal core, so the core keeps at least that many rows of plain, coloured and syntax-highlighted output at any width instead of a fixed number of bytes that held 5,300 rows at 80 columns and 2,200 at 200. `terminal_core_open` now takes the setting in lines. The native core is not reachable from the app yet and xterm.js stays the only engine, so terminal behaviour does not change and no defaults change.
