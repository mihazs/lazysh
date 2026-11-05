---
"@lazysh/client": minor
---

Show a live Herdr agent's lifecycle state when Herdr reports Unknown, as Herdr 0.9.3 does for an idle Codex prompt. If the pane's Herdr-reported session ID is unique among live panes and matches exactly one companion report from the same connection, the pane shows Working, Needs attention or Done. Herdr's own states take precedence, workspace and tab summaries stay Herdr's, and a pane without an exact match stays Unknown.
