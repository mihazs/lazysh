---
"@lazysh/client": minor
"@lazysh/agent": minor
---

feat(multiplexers): open the exact tmux, rmux or Herdr pane that raised an agent notification

Opening an inbox row, tapping a desktop notification or choosing **Open session** now focuses the pane of the event on the tmux or rmux server the event names (`paneServer`), or on the attached Herdr server for a `herdr:<session>:<pane id>` pane. A tmux or rmux pane of another server than the one your terminal is attached to is refused instead of guessed, and the Agent view, the status bar's current-pane agent and Jump To ignore a report of another server, so `%7` of `tmux -L work` is no longer taken for `%7` of the default server. The companion now records the Herdr pane of a hook run inside Herdr. Reports from companions that record no server keep today's behaviour (the attached server). No defaults change.
