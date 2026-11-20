---
"@lazysh/client": minor
---

feat(desktop): bundle lazysh-agent with the Linux and Windows packages and prove it in the release

Ship the matching `lazysh-agent` companion with every desktop package and prove it in the release checks (#1666, part of #1132). The Linux Debian package (`/usr/bin/lazysh-agent`) and AppImage and the Windows installer (`lazysh-agent.exe` beside the app) now carry the very companion the release's companion job built and verified for that platform, so a fresh install has a local companion where the local arm looks first (beside the app, then the managed copy, then the `PATH`, unchanged). The desktop release builds download that artifact, bind its receipt to the commit and version, and stage it through a Tauri `bundle.externalBin` entry used by release builds only. The release job unpacks each package and refuses to publish one whose companion is missing, not executable or different from the published one; the installer acceptance also checks it after the install and after the same-version repair. The AppImage copy is compared with its `RUNPATH` section rewritten by linuxdeploy ignored. The installers grow by one companion executable (about 11 MB). No defaults change; remote companion resolution and installation are unchanged, and macOS packages, which stay deferred, have the check in place but unexercised.
