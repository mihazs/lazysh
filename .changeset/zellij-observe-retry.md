---
"@lazysh/client": patch
---

test(android): retry the Zellij fixture's tab readback when the command fails

The first readback after the session starts could exit 1 under load and fail the whole case. A failing command is now retried like an unreadable answer; one that keeps failing still surfaces its own error. Test only. No user-visible behaviour changes.
