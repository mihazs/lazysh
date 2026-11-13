---
"@lazysh/agent": minor
---

Add an optional operating system timer for the companion's update check. `lazysh-agent auto-update enable` installs it for the user's own account, without `sudo`: a systemd user timer on Linux, a launchd agent on macOS and a Scheduled Task on Windows, all waking the managed companion's `auto-update run` every hour (which decides from the settings whether a check is due). `auto-update disable` removes it and only files that carry the lazysh marker; `auto-update status` reports `timer`. `enable` exits 40 while the policy is `off`, 41 when the account cannot have a timer and 42 when the system refuses, putting the files back. No default changes: the timer is off until enabled.
