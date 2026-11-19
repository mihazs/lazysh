---
"@lazysh/client": patch
---

Give the native terminal core the app's colours and the Mosh canonical-frame mode when a session opens: `terminal_core_open` takes an optional config with the app's terminal theme and `canonicalFrames`, and `terminal_core_theme` changes the colours of a running session, so a program that asks the core for its colours hears the theme the user chose and a theme change answers the next query. The client's bridge passes the theme when it opens a core and sends a changed theme. Nothing registers the native engine yet, so terminal behaviour and defaults do not change; xterm.js stays the only engine.
