---
"@lazysh/client": patch
---

Extend the Android recreation test with the private keyboard command and with the activity that the file exchange and background session plugins read after the activity is recreated, so a plugin that keeps the first activity fails the instrumented run (#1462). Test-only; no behavior change.
