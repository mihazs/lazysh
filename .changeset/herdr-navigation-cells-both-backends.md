---
"@lazysh/client": patch
---

test(terminal): Hold Herdr's navigation-cell detection to both terminal backends

Part of #1318 and #1302. `herdrNavigationCells.test.ts` now runs each case over the xterm.js adapter and over the native terminal adapter on the stand-in core, on the same bytes, so the right-trimmed, bounded window of rows the native adapter reads gives the same switch-button, switcher and on-screen answers as xterm.js. Test-only: no behaviour, engine or default changes, and xterm.js stays the only registered engine.
