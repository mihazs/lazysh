---
"@lazysh/client": patch
---

fix(credentials): import ECDSA P-256 private keys whose secret starts with a zero byte

About one OpenSSH ECDSA P-256 key in 256 failed to import with "Cannot unlock this private key", encrypted or not, because the SSH key decoder rejected the shortened 31-byte secret OpenSSH writes for it. Those keys now import and authenticate like any other.
