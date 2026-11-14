---
"@lazysh/client": patch
---

Prove the dictation auto-send payloads against a real PTY: dictated text without Enter stays an unsubmitted line in an owned local terminal, a lone Enter submits it, and text plus Enter in one write runs as a command.
