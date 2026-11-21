---
"@lazysh/client": patch
---

fix(terminal): Long-press a URL selects and copies the whole address, however it wraps

A URL that wraps over several terminal rows, or that an agent prints hard-wrapped inside a box, was copied cut at the row end or with line breaks, borders and spaces in it, so the pasted address was broken. Long-pressing any part of a URL now selects all of it and Copy puts exactly the URL on the clipboard.
