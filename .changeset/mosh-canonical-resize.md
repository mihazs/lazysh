---
"@lazysh/client": patch
---

Keep Mosh repaint geometry synchronized with each complete server frame so keyboard, composer and viewport resizes do not duplicate the screen into local scrollback. Preserve existing history cells without reflow; narrow views can clip old history until widened.
