---
"@lazysh/client": minor
---

feat(agents): answer permission requests from the Agent view dock in Zellij and Herdr panes

The dock shows the requests of the exact Zellij pane the one agent report names, and under Herdr only those of the focused pane (a request that names no pane still matches by session id). Nothing is sent when the pane is no longer named exactly.
