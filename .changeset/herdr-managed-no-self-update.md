---
"@lazysh/client": patch
---

Keep the optional `lazysh-managed` guarded Herdr build from replacing itself with a stock Herdr release: `herdr update`, the self-update behind `herdr channel set` and the background update check refuse or never run, with the reason that updates arrive only through lazysh, and the Herdr native job proves on the real built binary that none of them downloads or replaces anything.
