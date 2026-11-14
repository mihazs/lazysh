---
"@lazysh/client": patch
---

Fix the Android SSH fixture teardown failing with "Owned Herdr root identity unavailable" when the Herdr supervisor had already exited cleanly. A cleanly exited root now counts as stopped, while a failed or signaled exit and any surviving receiver still fail the cleanup.
