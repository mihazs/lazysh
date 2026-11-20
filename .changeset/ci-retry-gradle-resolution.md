---
"@lazysh/client": patch
---

ci(release): retry release Android builds when a Gradle dependency download fails

The release source build and the Android artifact job rerun their Gradle build, up to five
attempts 1, 3, 6 and 10 minutes apart, when Gradle reports a failed dependency download (a Maven
registry 429 or 5xx, a dropped connection, a truncated POM or a missing group:artifact lookup).
The Android project's buildSrc also falls back to Maven Central when the plugin portal reports its
Kotlin classpath missing. Compile, test, lint and dependency-verification failures are never
retried, and no dependency cache or refresh is added, so release dependencies are still
downloaded and verified every time.
