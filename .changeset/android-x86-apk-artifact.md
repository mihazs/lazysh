---
"@lazysh/client": patch
---

ci(android): upload the x86_64 debug and androidTest APKs for the Waydroid lane

The `native-android-terminal-core` job now uploads `lazysh-android-debug-x86_64` (7 days) with the x86_64 debug APK and the instrumentation APK it already builds, so the Waydroid lane can install them with `--apk`. Nothing changes for users or in what the job builds.
