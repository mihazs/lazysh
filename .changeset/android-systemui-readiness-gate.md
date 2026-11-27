---
"@lazysh/client": patch
---

fix(ci): gate the Android emulator on SystemUI readiness before native cases

A boot-time SystemUI ANR now reboots the guest (at most twice) or fails the job early with a named cause, instead of failing the first native case with an unfocused window.
