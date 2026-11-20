---
"@lazysh/client": patch
---

ci(herdr): build the managed Herdr as a release-profile executable and state its libc floor

The Herdr native job builds the optional managed Herdr derivative as a release-profile Linux x86-64 executable, runs the owned real-server acceptance against those exact bytes, fails when the executable needs a glibc above the documented 2.35 floor, and retains it with a receipt binding the source commit, original manifest digest, feature set, toolchains and SHA-256. Nothing is published and no platform support is claimed yet.
