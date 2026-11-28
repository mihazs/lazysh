---
"@lazysh/client": patch
---

docs(install): compare the Windows installer SHA-256 with its release checksum in PowerShell

The Windows section of the install guide gains a PowerShell example that looks up the installer in the same release's `SHA256SUMS`, prints `MATCH` or `MISMATCH`, and says what a mismatch means. Documentation only: no behavior change.
