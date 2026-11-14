---
"@lazysh/client": minor
---

Add Jump To for Zellij (#1145, part of #1138). A terminal attached to a Zellij 0.45.1 session now offers **Jump To** with the session's tabs, numbered from 1, and exactly one **Current** row (the tab Zellij reports active); choosing another tab switches to it by its stable id (`go-to-tab-by-id`). It follows the same list, accordion and grid layouts as tmux, and Zellij 0.44.x, which the version gate marks without the `tree` capability, shows no Jump To. Panes are not destinations: Zellij 0.45.1's `focus-pane-id` does not move the attached client, so a jump lands on the tab's own focused pane.
