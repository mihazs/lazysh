---
"@lazysh/client": patch
---

test(ntfy): record what the Android app did with each pushed challenge when confirmation times out

Count in memory what the Android app does with each pushed ntfy challenge message and retain only those closed counts in the failure receipt when the unchanged 15-second challenge confirmation fails. This separates a message the distributor never delivered from one the app dropped; it is diagnostic evidence, not a confirmation or delivery fix.
