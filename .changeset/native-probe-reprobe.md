---
"@lazysh/client": minor
---

feat(settings): add "Check this device again" beside the reason Native is off

When Settings, Terminal engine says Native is turned off, a "Check this device again" button (English, Brazilian Portuguese and Spanish) now asks the device again whether it can draw a native terminal, instead of keeping the first answer until the app restarts (#1336, part of #1302). A driver that was updated or a display that changed is picked up without a restart, and Native becomes selectable if the device now passes. The probe is still bounded to 2 s. No release build passes the probe yet, so nothing changes for users who do not press it; no default changes.
