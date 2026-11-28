---
"@lazysh/client": minor
---

ci(release): publish the managed Herdr as verified release assets

Each release now also carries the managed Herdr executable for Linux x86-64 (`lazysh-<version>-linux-herdr-x64.bin`) and its notice inventory, notice text and build receipt, all listed in `release.json` and `SHA256SUMS` and checked against the tag after publication. Installs stay opt-in and no platform support is claimed.
