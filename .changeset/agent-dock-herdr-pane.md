---
"@lazysh/client": minor
---

Require the exact Herdr pane for the Agent view approval dock: under Herdr the dock shows only the requests that name `herdr:<attached session>:<focused pane id>` (a request that names no pane still matches by session id) and sends a decision only after Herdr's tree again shows that pane focused and running the one reported session.
