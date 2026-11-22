---
"@lazysh/client": patch
---

feat(terminal): Hand a native terminal session's transport back to the WebView without losing bytes

Part of #1342. With the optional `native-terminal` feature the app has two new commands: `terminal_core_ansi_snapshot` answers with the visible screen, cursor and modes of a native session as bytes a fresh terminal replays, and `terminal_core_release` re-routes the session's output to a new WebView Channel at a chunk boundary and answers with that snapshot, so every byte is applied once and in order. Scrollback is not carried over. Nothing calls the commands yet, so terminal behaviour and defaults do not change.
