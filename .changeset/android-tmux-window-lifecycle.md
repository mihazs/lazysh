---
"@lazysh/client": patch
---

Extend the Android tmux acceptance case: through the real UI it now creates a window and renames it from the Workspaces panel, then closes it from the tab strip with a held finger, the menu's Close and the confirmation, and the host checks that its own tmux tree showed each name in order and then only the original windows. Test-only; no behaviour changes.
