---
"@lazysh/agent": minor
---

Add the host browser switch, off by default, in its own `host-browser.json` (`lazysh-agent settings host-browser show|update`), so that `settings.json` keeps the five fields a released client reads. The hidden browser launcher fails before it starts a process while the switch is off, keeps its profile in a private directory with a pid marker, removes it when it stops or at the next start after a crash, and offers `--keep-profile` and `host-browser --clear-data`.
