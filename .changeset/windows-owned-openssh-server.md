---
"@lazysh/client": patch
---

Add the owned Windows OpenSSH server the Windows GUI SSH case will connect to, and a hosted Windows check that proves it with the real `ssh.exe`: a second `sshd` run by the job user on a fresh loopback port with one throwaway key, accepting only that key, offering the fingerprint the application must show, and leaving the machine's own `sshd` service and every other file untouched. Test infrastructure only; the application, its defaults and the release artifacts are unchanged.
