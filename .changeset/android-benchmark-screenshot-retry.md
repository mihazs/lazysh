---
"@lazysh/client": patch
---

fix(bench): retry transient Android display capture misses

The benchmark keeps the original timing window and counts only real screenshot observations. A sustained capture failure still fails the run.
