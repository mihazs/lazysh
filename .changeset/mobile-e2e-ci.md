---
"@lazysh/client": patch
---

Run the Appium device suite on the API 36 emulator in CI (report-only): a path-filtered `native-android-appium` job with tier, quarantine and shard selection, one fresh-session retry per spec file with a flaky-spec job summary, JUnit and failure artifacts, a never-gating quarantine job and a nightly run. Test infrastructure only; no product change.
