---
"@lazysh/client": patch
---

Measure the native terminal core against xterm.js on the exact bytes of the recorded terminal baseline (#1303, part of #1302): the benchmark workloads W2, W3 and W4 can now be written to files and parsed by both engines, and on one desktop host the core parses them 1.6 to 7.7 times faster than xterm.js's `write()` at the parse stage, with the final screens equal to the baseline's. Measurement and documentation only: the terminal engine is unchanged, xterm.js stays the only engine and the default, and no setting or default changes.
