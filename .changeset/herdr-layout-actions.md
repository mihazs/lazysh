---
"@lazysh/client": minor
---

feat(herdr): close, rename and resize Herdr panes and close Herdr workspaces from the Workspaces panel

Each pane row shows its label and gains Rename, four divider arrows and Close, and each workspace gains Close. Closing asks first with a confirmation that names the pane or workspace and sends one exact-id command only when confirmed. A workspace that still has linked worktree workspaces is refused by Herdr and lazysh never closes the group. No defaults change.
