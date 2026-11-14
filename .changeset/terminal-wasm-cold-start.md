---
"@lazysh/client": patch
---

Record the cold start of the WebAssembly build of the terminal core against xterm.js in Node, as measured evidence for the terminal engine decision (#1323). Benchmark script and raw results only: the terminal engine is unchanged, xterm.js with its DOM renderer stays the only engine and the default, and no setting or default changes.
