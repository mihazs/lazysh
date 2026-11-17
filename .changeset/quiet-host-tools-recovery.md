---
"@lazysh/client": patch
---

fix(ssh): recover the host-tools connection of Mosh and Eternal Terminal sessions automatically

Active Mosh and Eternal Terminal sessions now restore their command-only SSH connection when it closes, without replaying interrupted commands. This changes the default recovery behavior; jump hosts, agent forwarding, biometric and unsaved credentials still need manual recovery.
