---
"@lazysh/client": minor
---

feat(agents): show each session's name first in the Agent view and let you rename it

A session the companion has named, from its first prompt, now shows that name first on the Agents board, the all-hosts board, the selected report and the Agent view header, with its summary, folder and agent as secondary detail. Search matches the name. **Rename** in the selected report gives a session your own name, kept on this device under the saved host: it wins over any reported title, survives restarts and new reports, and saving it empty brings the reported title back. A host companion that reports no title, or an unusable one, shows the row as before. The name is one line of at most 80 characters with control characters removed.

Changed default: a named session's row leads with its name instead of its latest summary, and a screen reader announces the name and the agent.
