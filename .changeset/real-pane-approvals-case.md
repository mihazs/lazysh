---
"@lazysh/client": patch
---

test(approvals): run Claude hooks in real Zellij and Herdr panes over owned OpenSSH

The owned OpenSSH approvals suite now also runs Claude permission hooks inside a real Zellij pane and a real Herdr pane, and checks that the client lists each request with exactly that pane, allows and denies from it, refuses every other pane, and drops a request whose hook ended at the host. No default or behaviour changes.
