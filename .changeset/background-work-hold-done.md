---
"@lazysh/agent": minor
---

feat(agent): hold a Claude Code done push while the session still runs background work

The relay no longer sends "done" the moment `Stop` is reported while Claude Code's own records say the session still runs a background shell, monitor, sub-agent or workflow (or has started a turn no hook reported): the push is looked at again every 20 seconds, sent once nothing is open, dropped when the session reports another state (the resumed turn), and sent anyway after an hour. Changed default: a done push can arrive up to an hour after the turn ended. Sessions with no such evidence, other agents and every other push are unchanged, and the outbox schema is the same.
