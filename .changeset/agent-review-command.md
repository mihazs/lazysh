---
"@lazysh/agent": minor
"@lazysh/client": patch
"@lazysh/common": patch
---

Add `lazysh-agent review status` and `review diff` to the host companion: the Diff view's changed files and one file's patch from a terminal on the host, as plain text or one JSON line, read-only and under the app's size bounds, with its help in English, Brazilian Portuguese and Spanish. The app and the companion now build their Git review commands in one shared module; the app's behavior does not change.
