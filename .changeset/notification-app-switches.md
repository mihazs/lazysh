---
"@lazysh/client": minor
---

feat(notifications): add the nested-agent and unlocked-desktop switches to the host settings panel

Add the two notification switches to the host settings panel: **Do not notify for nested agents** and **Do not notify while this desktop is unlocked**, in their own form with their own revision and **Save notification switches** button, so saving them never changes the three host switches. Both are off by default; nothing changes until you turn one on. They read and save the companion's `settings notifications` setting and appear only for a companion that answers it; an older companion shows an update message. The panel says that the unlocked-desktop switch works on Linux hosts only (any other host always notifies) and that the nested-agent switch relies on process ancestry on Linux and macOS and on `LAZYSH_PARENT_SESSION_ID` on every host. The strings are in English, Portuguese (Brazil) and Spanish.
