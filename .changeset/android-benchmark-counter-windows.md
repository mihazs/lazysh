---
"@lazysh/client": patch
---

fix(bench): exclude interrupted Android counter windows from engine comparisons

Guest CPU, idle and frame counters are omitted when a counted process exits during the window. Independent throughput and latency samples remain available.
