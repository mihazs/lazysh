---
"@lazysh/client": patch
---

Give each owned SSH/SFTP fixture launch a private host-trust file so concurrent clients cannot rewrite another client's pin, preserving strict verification and cleanup.
