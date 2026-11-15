---
"@lazysh/client": patch
---

Fix the owned Android SSH parity job on the Ubuntu 22.04 CI runner (#1737): its host-side check of the Files fixture read the SFTP listing as OpenSSH 10 prints it (path-prefixed names) and found nothing in OpenSSH 8.9's bare names, so the job failed after the emulator cases had passed. The listing now accepts both. Test infrastructure only; the app is unchanged.
