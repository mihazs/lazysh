---
"@lazysh/agent": patch
---

test(agent): hold the storage gate in every test that flushes, so the slow-flush case stops flaking

Five CLI tests opened stores or ran the companion without the cross-process volume gate, and their durable flushes queued in front of the sixteen-writer burst of `concurrent_hooks_preserve_every_event` under the simulated slow volume. No shipped behavior changes.
