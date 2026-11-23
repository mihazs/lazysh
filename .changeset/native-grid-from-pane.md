---
"@lazysh/client": patch
---

feat(terminal): Size a native terminal's columns and rows to its pane, so the remote program draws for the screen it has

Closes #2397, part of #1327. A native terminal pane, which is opt-in (Settings, Terminal engine), opened at 80 x 24 and stayed there, whatever the pane's size, a rotation, the soft keyboard, a pinch or a font change. It now holds the whole cells its pane fits at the renderer's cell size, asks the transport for that grid (the core and the remote PTY follow) and fits again when the pane, the font size or the display density changes. The new `native_terminal_surface_cell` command answers the renderer's cell so the page and the renderer share one rule. A pane that is not a whole number of cells has a margin at its right and bottom. Mosh's canonical resize on native is still its own slice, and the default engine is unchanged.
