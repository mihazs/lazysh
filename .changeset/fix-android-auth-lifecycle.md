---
"@lazysh/client": patch
---

test(android): wait for the auth activity to resume before the instrumentation test continues

The Android auth instrumentation test no longer reads a transitional RESTARTED state, so the owned emulator job stops failing intermittently. No app behavior changes.
