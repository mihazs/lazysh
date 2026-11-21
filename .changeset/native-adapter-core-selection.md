---
"@lazysh/client": patch
---

feat(terminal): Take the word under a touch and select all from the native core

Part of #1334. The native adapter asks the core for the word under a cell and for the whole buffer, so a double tap or Select all covers wrapped lines, wide characters and scrollback outside the adapter's window of rows. No released build can select the native engine, so terminal behaviour and defaults do not change and xterm.js stays the only engine a user can run.
