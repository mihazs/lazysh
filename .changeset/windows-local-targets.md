---
"@lazysh/client": minor
---

feat(desktop): choose PowerShell, Git Bash or a WSL distribution for a local terminal on Windows

Choose PowerShell 7, Windows PowerShell, Git Bash or a WSL distribution for a local terminal on Windows. The target list is detected natively, the app sends only the chosen id, an id that is not installed is refused, and a session saves its target for workspace restore. The default shell is unchanged. WSL targets open the distribution's login shell.
