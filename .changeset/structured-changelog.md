---
"@lazysh/client": patch
---

docs(changelog): Write release notes as New, Improved and Fixed lists with one linked line per change

Each release's notes on GitHub and in `CHANGELOG.md` are now generated from the changeset fragments: a fragment's first line is `type(scope): headline`, the rest is collapsed details, and the notes group the lines as New, Improved, Fixed, Documentation and Under the hood with a link to the pull request. They no longer carry commit hashes, dependency-update lines or repeated "Also included" blocks; the versions that were prepared but never published are listed in one line. Root `CHANGELOG.md` now has a section per release, and its earlier hand-written log is grouped under "Development history". A separate `[Unreleased]` entry is no longer required. No application behaviour and no defaults change.
