---
"@lazysh/client": patch
---

Teach the shared Rust terminal core to read the text of any rows of its screen and scrollback, optionally one column span, and to report where the visible rows sit in the buffer, with the same results as the xterm.js engine on a shared set of screens. This is what Herdr's phone navigation needs to find its switch button. The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
