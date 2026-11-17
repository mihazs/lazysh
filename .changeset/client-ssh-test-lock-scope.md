---
"@lazysh/client": patch
---

Release the fixture's command-log lock before the Herdr conversation retry test awaits again, so the native Linux lint (`clippy::await_holding_lock`) passes. Test-only; no behaviour change.
