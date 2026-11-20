---
"@lazysh/client": patch
---

feat(terminal): find web addresses, file paths and hyperlinks in the shared terminal core

Part of #1320 and #1302. The shared Rust terminal core can now find the web addresses (URLs) and host file paths on a row of its screen or scrollback, including those a program wrapped over several rows or broke at a box border, and read the hyperlinks (OSC 8) an application draws. On 33 shared screens it returns the same addresses, paths, line and column numbers and cell ranges as the existing xterm.js link code. The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
