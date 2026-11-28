---
"@lazysh/client": patch
---

test(android): observe the system clipboard after tmux passes a DCS-wrapped OSC 52 through

After the reattach, the owned tmux case prints a DCS-wrapped OSC 52 into the attached display, requires the consent region, taps Allow this copy and reads `ClipboardManager`; the consent, Allow and clipboard wait is shared with the SSH clipboard case. Test coverage only; no app behaviour changes (#1546).
