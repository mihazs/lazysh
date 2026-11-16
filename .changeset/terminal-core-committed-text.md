---
"@lazysh/client": patch
---

Let the native terminal bridge receive the text a soft keyboard or an IME committed (#1791, part of #1328): a `text` event reaches the terminal verbatim, whatever keyboard protocol or bracketed paste the program enabled. The core is not wired into the app, so nothing changes for users: xterm.js stays the only engine and no setting or default changes.
