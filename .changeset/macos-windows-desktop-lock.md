---
"@lazysh/agent": minor
---

Read the lock state of a macOS or Windows host desktop for the opt-in `suppressWhileDesktopUnlocked` notification switch, and the process ancestry of a Windows host for the nested-agent switch. Only a known unlocked console session suppresses; a locked, unreported or unreadable state, or a hook that runs outside the console session (over SSH, in a service or in Remote Desktop), still notifies. Both switches stay off by default. No real lock or unlock transition on macOS or Windows hardware was observed.
