---
"@lazysh/client": patch
---

Build the optional managed Herdr derivative as a release-profile Linux x86-64 executable in the Herdr native job, run the owned real-server acceptance against those exact bytes, fail when the executable needs a glibc above the documented 2.35 floor, and retain it with a receipt binding the source commit, original manifest digest, feature set, toolchains and SHA-256. Nothing is published and no platform support is claimed yet.
