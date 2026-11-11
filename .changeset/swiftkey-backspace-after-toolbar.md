---
"@lazysh/client": patch
---

Fix Backspace and word corrections from the phone keyboard (reported with SwiftKey) being skipped after a toolbar key or a mouse report: Backspace over typed text now always reaches the terminal, and wheel scrolling in a mouse-tracking program no longer ends the keyboard edit record.
