---
"@lazysh/agent": minor
---

feat(agent): keep a Claude Code session working while it runs background shells, monitors, sub-agents or workflows

`lazysh-agent snapshot` no longer reports a Claude Code session as done after `Stop` while its own records show work still running: the session registry's `shell` status (believed only while the agent process lives) and the `turn_duration` counts of background sub-agents and workflows. The row reads `working` ("Working in the background") with an optional `background` object (`agents`, `workflows`, `shells`), and `working` ("Turn resumed") when a finished task started a turn no hook reported yet. Changed default: a snapshot row the hooks left `done` can now read `working`. The stored state is unchanged, a dead process or an unreadable record leaves the hook state, and older clients and companions are unaffected.
