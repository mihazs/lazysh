---
"@lazysh/client": patch
---

feat(terminal): Draw a native terminal with the user's theme, font, bold colours and cursor, and change them live

Closes #2380, part of #1327. A native terminal pane, which is opt-in (Settings, Terminal engine), now follows Settings: the theme and palette, the font family and size (a pinch included), bold text in the bright colours or a custom bold colour, and the cursor's style and blink reach its renderer when they change, instead of the fixed 14 px monospace in the default theme. The new `native_terminal_surface_look` command carries them. A program that sets its own cursor (vim's block in normal mode) keeps it until it gives it back, as under xterm.js. The grid does not follow the pane's size yet, and imported fonts are not drawn. The default engine is unchanged.
