---
"@lazysh/agent": patch
---

fix(notifications): start the enabled host relay sender automatically

Agent reports restart an absent sender. Hosts that use an external supervisor can set `LAZYSH_RELAY_AUTOSTART=0`.
