---
"@lazysh/agent": patch
---

fix(agent): a loaded machine no longer makes the Agent view fail to read an OpenCode or Hermes conversation

Reading an OpenCode or Hermes conversation from its SQLite database stops after a 2 second budget so a malformed database cannot run away. The budget counted elapsed time, so a companion that a busy or throttled machine left waiting for its turn was interrupted with `interrupted` even though the read was cheap. The budget now counts the CPU time the read uses: a stalled reader is never cut off, and a runaway query still is (as is one that exceeds the 10 million SQLite step cap, which is unchanged). On Windows the budget still counts elapsed time.
