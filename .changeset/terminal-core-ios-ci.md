---
"@lazysh/client": patch
---

Build libghostty-vt against the iPhoneOS and iPhoneSimulator SDKs and test the terminal core for iOS in a new report-only `terminal-ios` CI job on pushes to `main`: the runtime's tests are linked for `aarch64-apple-ios` and every test runs inside a booted iOS simulator for `aarch64-apple-ios-sim`, so a break that only shows on iOS no longer waits for a native surface to be written. The core is not wired into the app yet: no behaviour changes for users.
