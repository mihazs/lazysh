---
"@lazysh/notification-service": patch
---

Add an owned API 36 emulator acceptance lane (`native-android-gotify`) for the unchanged official Gotify Android app. The real Gotify server feeds the app on a loopback-only plain-HTTP listener while the relay still delivers over verified HTTPS, so no CA import through the Android file picker is needed. Test-only: the relay and the app do not change, and no defaults change.
