---
"@lazysh/client": patch
---

Drive an authenticated SSH terminal through the installed Windows GUI check: it adds a host for the owned Windows OpenSSH server through the real Add host editor, pastes the throwaway private key without saving it, requires the host-verification dialog to show the server's own fingerprint, trusts it, and requires the remote `cmd.exe` shell to compute an answer for a command typed with real key presses, with the server's log recording the accepted key. The step stays `continue-on-error` until the cases have passed in a `main` run. Test-only; the application, its defaults and the release artifacts are unchanged.
