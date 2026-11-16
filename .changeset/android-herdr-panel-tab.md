---
"@lazysh/client": patch
---

Extend the Android shared Herdr navigation case: after the workspace create, rename, split and zoom steps it now clicks `New Herdr tab` on the renamed workspace in the Sessions panel's Herdr browser (a typed label and the fixture directory), waits for the panel to list the tab, and the host reads the tab back from Herdr itself (label, directory, the workspace it belongs to and the tab count) while the zoomed pane and the two original navigation workspaces stay as they were. Test-only; no behaviour changes.
