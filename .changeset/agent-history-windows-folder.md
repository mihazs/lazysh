---
"@lazysh/client": patch
---

Fix the Windows companion test run: the Agent view history tests used POSIX-only folders that Windows rejects as relative, so `native-desktop (windows-latest)` failed on `main`. They now use a drive-qualified folder and Claude Code's `C--` project directory name on Windows. Test-only; the history listing itself is unchanged.
