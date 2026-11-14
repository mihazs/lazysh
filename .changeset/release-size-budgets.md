---
"@lazysh/client": patch
---

Refuse to stage or publish a release package that is more than 1.5 times the size measured on v1.62.0, and record the measured sizes of every published package in the release documentation. Release tooling only; installed applications do not change.
