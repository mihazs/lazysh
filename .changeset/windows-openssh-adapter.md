---
"@lazysh/client": minor
---

feat(companion): run the companion on Windows hosts reached over OpenSSH

Run the companion on Windows hosts reached over OpenSSH (#1725, part of #490). A host whose POSIX probe exits non-zero is now asked a second, PowerShell probe (`powershell.exe -EncodedCommand`) that reports its architecture, SID and local application data directory, and every companion command is sent to it as one encoded PowerShell line that `cmd.exe`, Windows PowerShell and POSIX quoting pass unchanged. Arguments Windows PowerShell 5.1 cannot pass faithfully are refused. Hosts that answer the POSIX probe are unchanged; installation, hook setup and the Herdr lookup stay Unix-only. Changed default: a host whose POSIX probe fails also gets the Windows probe.
