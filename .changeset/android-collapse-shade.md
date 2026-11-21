---
"@lazysh/client": patch
---

test(android): collapse the notification shade and system dialogs before a case and when the window loses focus

Back sent while the notification shade was still expanding left it open, so the app window never regained focus and every later owned SSH case failed with "Native workspace not ready". The cases now collapse the shade through the shell. Test only. No user-visible behaviour changes.

An instrumented case that blocks now fails after 15 minutes (runner argument `timeout_msec`) instead of holding the job until its 75 minute limit.
