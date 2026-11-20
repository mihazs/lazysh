---
"@lazysh/client": minor
---

feat(desktop): run Files and Diff inside a WSL target on Windows

Run **Files** and **Diff** inside a WSL target on Windows (#1745, part of #1135). A WSL session runs Git and every other host command as `wsl.exe -d <distro> --cd ~ -e <argv>` (argv, no shell string, the same deadline, output bound and process-tree cleanup as a native command) and reads and lists files through `\\wsl.localhost\<distro>\`. Only a Linux path, a `\\wsl.localhost\<distro>\` path of the same distribution or a Windows drive path (translated with `wslpath`) is accepted; other UNC hosts, other distributions, device paths and `..` escapes are refused. A distribution reports **Files** and **Diff** once `git` starts inside it. Native Windows, Linux and macOS targets are unchanged.
