---
"@lazysh/client": patch
---

Build libghostty-vt against the Apple SDK and run the terminal core's and the wgpu renderer's tests on `macos-latest` (aarch64-apple-darwin, the renderer on Metal) in a new report-only `terminal-macos` CI job on pushes to `main`, so a break that only shows on macOS no longer waits for a native surface to be written. The first hosted run found that a macOS build of libghostty-vt sends no ESC prefix for Alt unless told Option is Alt, so the core now says so on every key encode; two tests that assumed a non-Apple host were fixed. The core is not wired into the app yet: no behaviour changes for users.
