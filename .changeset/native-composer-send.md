---
"@lazysh/client": patch
---

fix(terminal): the composer's Send and Insert submit and clear the draft on the native engine

On the native terminal engine, Send pasted the text but never pressed Enter and left the draft in the composer. Send now pastes and presses Enter, Insert pastes, and both clear the draft, as on xterm.js.
