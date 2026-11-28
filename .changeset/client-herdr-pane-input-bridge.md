---
"@lazysh/client": minor
---

feat(herdr): add the app-side bridge for pinned stock Herdr pane input

Add the app side of explicit pane input to an unchanged stock Herdr: a `herdr_pane_input` command that keeps the companion's pinned `herdr-pane-input` actor on one retained SSH channel and takes prepare, confirm, input and release under the access lease, with monotonic operations that are never resent. No screen uses it yet, so behaviour is unchanged.
