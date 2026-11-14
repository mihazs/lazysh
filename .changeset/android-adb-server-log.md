---
"@lazysh/client": patch
---

Keep the host adb server's own log (`adb-server-log.txt`, last 1 MiB) in the Android runtime artifact when a job fails, so an interrupted emulator transport records why the server dropped it (`connection terminated: <reason>`). Test infrastructure only; no product change.
