---
"@lazysh/client": patch
---

Verify through the real Android app that the optional client environment flag is saved with a host and sends `LC_TERMINAL=lazysh` to an OpenSSH server that accepts `LC_*`, while a host without the flag does not. The owned SSH test fixture can now start an sshd with `AcceptEnv LANG LC_*`.
