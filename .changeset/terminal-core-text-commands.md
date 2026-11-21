---
"@lazysh/client": patch
---

feat(terminal): Serve selection text, search, word and line lookups from the native core and draw the selection

Part of #1320 and #1302. The app has a command for each question about a native terminal's text (selected text, search, the word at a cell, the line at a row, the whole buffer and the screen) and one that hands the selection to the session, where the renderer host draws its visible part. The native adapter asks the core for the selected text and for the find box's search, so both cover the whole scrollback, wrapped lines and wide characters; OSC 52 writes reach the consent panel through the core's policy with the same 64 KiB bound. No released build can select the native engine, so terminal behaviour and defaults do not change and xterm.js stays the only engine a user can run.
