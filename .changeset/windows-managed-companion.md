---
"@lazysh/client": minor
---

feat(companion): run the managed Windows companion before the PATH one on OpenSSH hosts

Run the managed Windows companion before the `PATH` one on Windows hosts reached over OpenSSH (#1902, part of #1725 and #490). After the PowerShell probe identifies the host, the app reads `%LOCALAPPDATA%`, `lazysh`, `companion` and `lazysh-agent.exe` in one exec and decides them with the owner, DACL and reparse-point rules the companion's own admission uses: a link or junction, a directory another account can change, and an executable another account owns or can access are refused and reported, and the `PATH` lookup stays. An admitted file is run by its absolute path; a missing one, an unreadable namespace and a host that does not answer the read keep today's `PATH` lookup. The answer is remembered for the connection, so a change to the namespace is noticed on the next connection. Installation, hook setup and the Herdr lookup stay Unix-only. Changed default: a Windows host identified by the probe costs one more exec per connection.
