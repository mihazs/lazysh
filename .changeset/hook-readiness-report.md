---
"@lazysh/agent": minor
---

Add an additive `readiness` object to `lazysh-agent hooks status`: whether this host's companion store holds a lifecycle event of the selected agent and when the latest one arrived (read-only, never creating the store), with provider reload, provider trust, pane binding and remote delivery reported as `notChecked`. `reporting` and `trust` are unchanged.
