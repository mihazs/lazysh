---
"@lazysh/client": patch
---

fix(zellij): Split right and Split down start in the chosen Directory

Zellij ignores `--cwd` for a plain terminal pane, so a split in a directory other than the default `.` now runs your shell there as a command pane that closes on exit. The default `.` is unchanged.
