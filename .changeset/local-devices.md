---
"@lazysh/client": minor
---

Show Devices in a local session when an Android SDK `adb` (or, on macOS, `xcrun`) is found on this computer. The device commands and the Android and iOS video preview run the host companion as argv on this device, without SSH or a shell, and stop it and the tools it started when the preview stops, the session closes or the app locks. SSH sessions and defaults are unchanged.
