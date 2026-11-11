---
"@lazysh/client": patch
---

Fix the Files view not resolving paths that start with `~`: `~`, `~/x`, `$HOME/x` and `${HOME}/x` now expand to the SSH user's home as reported by the host's SFTP server, the resolved absolute path is shown, and `~otheruser` is refused with a clear message.
