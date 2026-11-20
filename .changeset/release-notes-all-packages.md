---
"@lazysh/client": patch
---

fix(release): List changes from every package in the release notes, not only the client's

The GitHub release notes and the release section of the root `CHANGELOG.md` were built from the client's changelog alone, so a change whose fragment named another package, such as the companion, was missing from them. They now take the version's entries from every `@lazysh/*` package changelog and list a change that names several packages once. Releases already published are not rewritten. No application behaviour and no defaults change.
