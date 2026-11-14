---
"@lazysh/client": patch
---

Bound the Windows Cline credential-store read with a deadline, a cap on stranded readers and a disk-file check on the opened handle, so a stalled store no longer holds the account quota check. Linux and macOS are unchanged; no defaults change.
