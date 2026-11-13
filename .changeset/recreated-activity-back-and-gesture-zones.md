---
"@lazysh/client": patch
---

Fix Back leaving the app and the phone gestures losing the system gesture zones after Android recreates the app's window (a navigation-style switch, for example). The Back handler and the gesture plugin are rebound to the new window.
