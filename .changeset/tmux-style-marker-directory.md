---
"@lazysh/client": patch
---

fix(tmux): start new sessions, windows and panes in directories whose name contains a style marker

A directory such as `a#[b]c` no longer makes tmux start the new session, window or split pane in Home.
