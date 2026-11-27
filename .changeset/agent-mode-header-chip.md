---
"@lazysh/client": patch
---

feat(agents): always show the agent's reported mode, approval and sandbox in the Agent view header

The header now draws the mode the agent reports even when it is the default one, plus a chip with the approval policy and sandbox when the agent reports them (Codex). An agent that reports nothing shows no chip.
