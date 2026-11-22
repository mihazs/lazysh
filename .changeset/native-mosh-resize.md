---
"@lazysh/client": patch
---

feat(terminal): run a Mosh session on the native terminal engine and let the server decide its size

A Mosh session on the native terminal engine now follows the server's display frames, so the grid is the size Mosh reports and the size of your pane is a request to the server, as on xterm.js. Before this, a Mosh session could not start on the native engine and Auto fell back to SSH. A frame the engine cannot apply ends the session instead of drawing a wrong screen. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.
