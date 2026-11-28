---
"@lazysh/client": patch
---

test(android): create a Herdr tab through the real Sessions panel in the shared navigation case

The case now clicks `New Herdr tab` on the renamed workspace (a typed label and the fixture directory), waits for the panel to list the tab, and the host reads the tab back from Herdr itself (label, directory, workspace and tab count) while the zoomed pane and the two original workspaces stay as they were. Test-only; no behaviour changes.
