---
"@lazysh/client": patch
---

Add a Chromium test for the two SwiftKey inputs that arrive as key events rather than text edits: Backspace over an empty terminal editor and Enter must each put exactly one byte on the wire (#1215). Test-only; no behavior change.
