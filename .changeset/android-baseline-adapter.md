---
"@lazysh/client": patch
---

fix(bench): verify adapter writes in the Android xterm baseline

The comparison driver now selects the app adapter and rejects results from the direct-write path.
