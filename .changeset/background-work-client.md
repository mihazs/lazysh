---
"@lazysh/client": minor
---

feat(agents): say what still runs in the background and never show idle or done while it does

A session whose turn ended while it still runs background sub-agents, workflows, shell commands or monitors now reads "Working in the background" in the Agent view header and the row above the composer, with what runs ("2 sub-agents · 1 shell or monitor"), and the Agents board row lists the same under its summary. A Herdr pane status of idle or done no longer outranks it. This needs a companion that reports the background work (#2958); against an older companion nothing changes. Strings in English, Portuguese and Spanish.
