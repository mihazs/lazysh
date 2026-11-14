---
"@lazysh/client": patch
---

Profile the first ANSI-heavy burst of the xterm.js WebGL renderer addon and record where its cost goes, as measured evidence for the terminal engine decision (#1323). Measurement and documentation only: the terminal engine is unchanged, xterm.js with its DOM renderer stays the only engine and the default, and no setting or default changes.
