---
"@lazysh/client": patch
---

Fix the owned Android SSH parity job on its CI emulator (#1737): the host-side check of the Files fixture read the SFTP listing as OpenSSH 10 prints it (path-prefixed names) and found nothing in the bare names of OpenSSH 8.9 on the Ubuntu 22.04 runner, and the Files and preview cases connected on the Auto transport, which starts a real mosh-server on their command-running sshds and failed intermittently with "Mosh connection ended before startup completed". The listing now accepts both formats and both cases choose SSH through the connect dialog. Test infrastructure only; the app is unchanged.
