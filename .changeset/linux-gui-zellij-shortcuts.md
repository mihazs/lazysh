---
"@lazysh/client": patch
---

Add a Linux native GUI case that attaches a real Zellij 0.45.1 session over owned OpenSSH, drives the Zellij shortcut panel (create tab, previous and next tab, quick tab) and asserts each tab change on the host, and checks that a Zellij-attached tab offers no Jump To. The SSH test fixture gained a pinned-Zellij option and the native Linux CI job installs the pinned Zellij before the GUI step. Test infrastructure only; no product change.
