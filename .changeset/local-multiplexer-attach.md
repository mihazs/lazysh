---
"@lazysh/client": patch
---

Let `local_connect` attach a tmux, Herdr or Zellij session on this device from a typed entry that becomes an argument list for the terminal's PTY, and bind tmux navigation to the attached terminal: the tmux, Herdr and server bindings move into one `Bindings` struct that SSH and local sessions share, and the tmux control client runs over any byte stream, here the pipes of a local `tmux -C attach-session` child. `tmux_jump` and `tmux_jump_snapshot` accept local session ids. The interface does not offer the choice yet, and SSH sessions behave as before.
