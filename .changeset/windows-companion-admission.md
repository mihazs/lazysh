---
"@lazysh/agent": minor
---

Admit the managed Windows companion namespace by owner, DACL and reparse point before `lazysh-agent update` and `installation` use it (#1724, part of #490). `%LOCALAPPDATA%\lazysh\companion` and `lazysh-agent.exe` are checked from the local application data folder down: a link, junction or other reparse point, a directory another account can change, an executable another account owns or can access, and an executable that is no regular file exit 27 (`unsafeInstallLocation`) from `update`, and fail `installation inspect` and `install` with `InstallUnsafeNamespace` or `InstallUnsafeFile`, before anything is created, run or replaced. On Windows, `installation inspect` now also reports the `destination` and the `existing` executable; Windows installation stays unsupported.
