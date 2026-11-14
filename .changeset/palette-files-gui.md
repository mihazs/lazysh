---
"@lazysh/client": patch
---

Add two Linux native GUI cases for the command palette and Files over a real SSH session: the palette opens with Ctrl+Shift+P from the focused terminal and with Ctrl+K elsewhere and runs the Files tool, the Terminal tool and End connection from the keyboard, and Files shows Markdown, a PNG and an SVG read over SFTP without running their content (#993). Test-only; no behavior change.
