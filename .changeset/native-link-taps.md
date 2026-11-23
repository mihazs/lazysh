---
"@lazysh/client": patch
---

feat(terminal): open links with a tap on the native terminal engine

A tap or click on a URL, an OSC 8 hyperlink or a file path in the native terminal engine now asks the engine what is under it and opens it through the same confirmation as xterm.js: a web address is offered to Open or Copy, and a path is opened only when the host confirms the file. A hold still selects, a drag still scrolls or selects, and a program that tracks the mouse keeps its clicks. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.
