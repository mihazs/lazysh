---
"@lazysh/client": patch
---

Extend the Android shared Herdr navigation case: it now drives the Sessions panel's Herdr browser to create a workspace, rename it, split its pane down and zoom it, and the host reads the workspace back from Herdr (label, directory, two panes and the zoom flag) while the navigation receivers stay at zero bytes. Test-only; no behaviour changes.
