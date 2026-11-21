---
"@lazysh/client": minor
---

feat(zellij): Jump To lists the tabs of the attached session with one current row

A terminal attached to a Zellij 0.45.1 session now offers **Jump To** with the session's tabs, numbered from 1; choosing a tab switches to it by its stable id (`go-to-tab-by-id`), in the same list, accordion and grid layouts as tmux (#1145, part of #1138). Zellij cannot address a client from the command line, so exactly one **Current** row shows and a jump is allowed only while this terminal is the one client attached to the session (#2046); with another client attached the tabs are listed without a current row and without a jump, because the jump could move that client instead. Zellij 0.44.x, which the version gate marks without the `tree` capability, shows no Jump To. Panes are not destinations.
