---
"@lazysh/agent": minor
---

Read the sub-agents, background commands and monitors of a Grok Build session into the Agent view's background-work panel, and show a Grok Build edit as the shared diff card (#1847, follow-up of #1285). In the conversation view, `subagent_spawned` and `subagent_finished` become a sub-agent row and `task_backgrounded` and `task_completed` a command or monitor row, each with its recorded end; a launch with no end stays running, and a record of another shape changes nothing. A completed `edit` call whose output is exactly one ACP `diff` becomes an `edit` call carrying that diff, and any other shape stays an ordinary tool block. The shapes come from the official writer source the Grok fixtures pin, not from a live session. No defaults change.
