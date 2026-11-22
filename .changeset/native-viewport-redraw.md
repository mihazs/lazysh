---
"@lazysh/client": patch
---

fix(terminal): redraw a native terminal's surface after a scroll or resize

Part of #1327. The native engine's renderer was only woken by output from the program, so scrolling a native terminal back through its history, returning to the bottom or changing its grid moved the core's viewport but left the drawn surface as it was until the program printed again. A scroll or resize a reader asks for now wakes the renderer like a screen change does. The native engine is still opt-in (Settings, Terminal engine).
