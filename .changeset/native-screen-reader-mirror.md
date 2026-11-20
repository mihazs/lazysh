---
"@lazysh/client": patch
---

feat(accessibility): mirror a native terminal session's rows for a screen reader while Screen reader mode is on

A session on the native engine has no text a screen reader can reach, so while Screen reader mode is on the terminal pane now mirrors its visible rows into a hidden list with a polite, bounded log of new output, and the session reports itself accessible only while that mirror is mounted. Nothing changes for users in this release: a session started with Screen reader mode on still gets xterm.js, native stays a developer-only choice, and no default changes.
