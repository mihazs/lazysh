---
"@lazysh/client": patch
---

Fix Split right and Split down in the Zellij panel ignoring the Directory field: Zellij ignores `--cwd` for a plain terminal pane, so a split in a directory other than the default `.` now runs the user's shell there as a command pane that closes on exit. The default `.` is unchanged.
