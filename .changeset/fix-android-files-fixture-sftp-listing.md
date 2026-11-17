---
"@lazysh/client": patch
---

Fix the owned Android SSH parity job on its CI emulator (#1737): the Files and preview cases connected on the Auto transport, which starts a real mosh-server on their command-running sshds and failed intermittently with "Mosh connection ended before startup completed". Both cases now choose SSH in the Add Host dialog. Test infrastructure only; the app is unchanged.
