---
"@lazysh/client": patch
---

test(e2e): add Appium specs for the soft keyboard against the terminal rows, toolbar and PTY size

The last row, the grid and the toolbar stay above the real keyboard (#1198), and the grid fills the free area with the host told the same rows (#1207). Test infrastructure only; the Mosh newest-output and Herdr navigation checks are tracked in #1493.
