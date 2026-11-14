---
"@lazysh/client": patch
---

Make the optional Herdr native CI build reuse hash-verified Zig package downloads and retry transient Ghostty dependency download failures, so a dropped connection no longer fails the job before its acceptance tests.
