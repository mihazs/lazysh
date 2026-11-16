---
"@lazysh/client": minor
"@lazysh/agent": minor
---

Show whether an agent's hooks reached the host. **Inspect setup** in the agent hook setup panel now lists the last time the host companion received a lifecycle report from the agent and whether that report carried a pane identity, next to the configuration status, so a configured but silent agent is told apart from a reporting one. Provider reload, project trust and remote delivery have no read-only probe and are listed as not checked, with what to do. `lazysh-agent hooks status` gains an additive `readiness` object and keeps `reporting` and `trust` as they were, so older apps and companions keep working together. The store is only read, never created, and nothing reads provider trust records.
