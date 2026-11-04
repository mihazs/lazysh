---
"@lazysh/client": minor
---

Add an opt-in per-host option that asks the SSH server to set `LC_TERMINAL=lazysh` for new SSH terminals and multiplexer attachments. It is off by default, needs the server's `AcceptEnv` to admit `LC_TERMINAL`, and is not sent by Mosh or ET sessions.
