---
"@lazysh/client": minor
---

feat(zellij): open the Zellij pane that raised an agent notification

Opening an inbox row, tapping a desktop notification or choosing **Open session** for an agent that ran in a Zellij pane now also focuses that pane, and the tab that holds it, in the Zellij session your terminal is attached to, so the Agent view follows that agent and not another one in the session (#1690, part of #1146). A pane of another Zellij session, or of another multiplexer, is left alone, and a pane that has gone still opens the session. No defaults change.
