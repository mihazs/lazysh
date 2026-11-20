---
"@lazysh/client": patch
---

feat(herdr): keep the managed Herdr build from replacing itself with a stock release

In the optional `lazysh-managed` guarded Herdr build, `herdr update`, the self-update behind `herdr channel set` and the background update check refuse or never run, with the reason that updates arrive only through lazysh. The Herdr native job proves on the real built binary that none of them downloads or replaces anything. Default Herdr builds and every shipped default are unchanged.
