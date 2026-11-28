---
"@lazysh/client": patch
---

test(android): answer Claude hooks running in real Zellij and Herdr panes from the device

The Android companion case now starts two waiting approval hooks in a pane of a private Zellij 0.45.1 server and a private stock Herdr server on the owned host, lists each with its exact pane on the device, allows one and denies the other by tapping, and checks each decision reached its hook. `native-android-runtime` installs the pinned Zellij and the same-run stock Herdr for it. No default or behaviour changes.
