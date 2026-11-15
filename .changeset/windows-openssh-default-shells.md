---
"@lazysh/client": patch
---

Run the app's own SSH client against a real Windows OpenSSH server in the hosted Windows job, once with `cmd.exe` and once with Windows PowerShell as the server's default shell. The server is the `sshd.exe` the image carries, started on a fresh loopback port with throwaway keys; each case asserts the shell it really ran under, identifies the host through the Windows probe, runs `lazysh-agent --version` and a command with a quoted argument through the adapter, and puts back the registry value it changed on every exit path. Test infrastructure only; the application, its defaults and the release artifacts are unchanged.
