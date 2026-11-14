---
"@lazysh/client": patch
---

Add a performance regression gate for the native terminal core to CI (#1341): a separate, non-required job runs the core's parse, frame, allocation, scrollback and memory metrics against limits and fails when one regresses, and proves on every run that it fails on an injected slowdown and on injected allocations. Nothing in the app changes: xterm.js stays the only terminal engine and the default, and no setting or default changes.
