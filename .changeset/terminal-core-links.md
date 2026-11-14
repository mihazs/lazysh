---
"@lazysh/client": patch
---

Teach the shared Rust terminal core to find the web addresses (URLs) and host file paths on a row of its screen or scrollback, including those a program wrapped over several rows or broke at a box border, and to read the hyperlinks (OSC 8) an application draws, with the same addresses, paths, line and column numbers and cell ranges as the existing xterm.js link code on 33 shared screens. The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
