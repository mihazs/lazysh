---
"@lazysh/client": minor
---

feat(terminal): Shift-drag selects under mouse tracking and a drag scrolls at the edge on the native engine

On the native terminal engine, holding Shift while dragging with a mouse now selects text even while a program (tmux, vim) tracks the mouse, and a drag held past the top or bottom of the terminal keeps scrolling and extending the selection, as on xterm.js.
