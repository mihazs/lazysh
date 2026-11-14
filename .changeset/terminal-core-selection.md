---
"@lazysh/client": patch
---

Teach the shared Rust terminal core to answer what text is under a selection (a range of cells, a word, a line, the whole buffer or the visible screen), to find text in the screen and scrollback, and to apply the clipboard consent limits (64 KiB, valid UTF-8, never partial) to the clipboard writes a terminal program makes with OSC 52, with the same results as the xterm.js engine on shared fixtures that cover wide and combining characters and wrapped lines. Five differences in what OSC 52 offers the user are recorded next to the fixture. The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
