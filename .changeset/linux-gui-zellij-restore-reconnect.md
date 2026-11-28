---
"@lazysh/client": patch
---

test(native-gui): run the Zellij restore and reconnect cases in the Linux GUI

Run the Linux native GUI restore and reconnect cases for Zellij as well as tmux (#1694, part of #1145): the bundled app attaches a real Zellij 0.45.1 session over owned OpenSSH, writes output, is killed (restore) or loses its SSH route (reconnect), and must show the same Zellij server, shell PID and pre-kill output, with no Zellij client attached before the **Restore previous workspace** click. A second case kills the Zellij session while the app is closed and expects the multiplexer-unavailable message, no terminal and no new session. Test infrastructure only; no product change.
