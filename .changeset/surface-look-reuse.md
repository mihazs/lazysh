---
"@lazysh/client": patch
---

refactor(terminal): reuse one native surface look for the Linux and Android hosts

The Linux surface host and the platform-neutral pane bookkeeping each built the same font and theme; both now use one function. No behaviour change.
