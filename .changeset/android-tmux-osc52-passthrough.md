---
"@lazysh/client": patch
---

Extend the Android tmux instrumentation case so that, after the reattach, the display's shell prints a DCS-wrapped OSC 52 that the owned tmux forwards: the app asks for consent, and after Allow the system clipboard holds the text (#1546). The consent, Allow and clipboard wait is now shared with the SSH clipboard case. Test coverage only; no app behaviour changes.
