---
"@lazysh/client": patch
---

Stop the Appium device run at once, with a non-zero exit and the holder's pid and age, when the device lock is still held after the wait (`LAZYSH_E2E_LOCK_TIMEOUT_S`, default 600 seconds), instead of starting workers that fail on missing hosts. Test infrastructure only; no product change.
