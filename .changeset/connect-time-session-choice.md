---
"@lazysh/client": minor
---

feat(connections): choose a multiplexer session right after connecting

Tick **Choose a multiplexer session after connecting** in the connection dialog to open **Sessions** on the new connection instead of its terminal, with tmux, Herdr and Zellij detected and their sessions listed (#478). The plain terminal of that connection stays open in its own tab, nothing is attached or created until you choose, and the saved host and its transport are unchanged. The option is off each time the dialog opens, is not saved, and is not offered for hosts with a saved default multiplexer, command-line launches, sign-in recoveries or reconnects. No defaults change.
