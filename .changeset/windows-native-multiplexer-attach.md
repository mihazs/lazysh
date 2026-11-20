---
"@lazysh/client": patch
---

feat(desktop): attach native Zellij and Herdr sessions on Windows through the ConPTY

Let `local_connect` attach a native Zellij or Herdr session on Windows through the ConPTY. The program is found on the `PATH` before the PTY starts, trying each directory in order with the name plus the `PATHEXT` extensions a process can be started from (`.com` and `.exe`; a batch file never resolves), and a program that is not installed is named in the error. tmux has no native Windows build, so a tmux entry is still refused there. The interface does not offer the choice yet, and attaching on Linux and macOS behaves as before.
