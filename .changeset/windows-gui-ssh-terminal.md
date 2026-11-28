---
"@lazysh/client": patch
---

test(windows): reach an owned SSH server from the installed GUI and refuse a rejected or changed key

Drive an authenticated SSH terminal through the installed Windows GUI check: it adds a host for the owned Windows OpenSSH server through the real Add host editor, pastes the throwaway private key without saving it, requires the host-verification dialog to show the server's own fingerprint, trusts it, and requires the remote `cmd.exe` shell to compute an answer for a command typed with real key presses, with the server's log recording the accepted key. A second case refuses a connection twice: the owned server rejects a throwaway key it does not authorize after the user trusted its fingerprint (the dialog reports the rejection and no terminal opens), and a replacement server on the same loopback port with another host key is refused with the right credential before it sees one (no trust prompt, no terminal, no accepted login in its log). Test-only; the application, its defaults and the release artifacts are unchanged.
