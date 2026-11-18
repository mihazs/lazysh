---
"@lazysh/client": patch
---

Release the fixture's command-log lock before the Herdr conversation retry test awaits again, and box the agent-board OpenSSH fixture so it fits a debug test thread's stack, so the native Linux lint (`clippy::await_holding_lock`) and owned OpenSSH checks pass. Test-only; no behaviour change.
