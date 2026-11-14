---
"@lazysh/client": patch
---

Extend the Linux GUI native suite with a generate-then-login case and with public-key refusals: a `.pub` file pasted into the connection form is refused after host-key review with no authentication, a `.pub` file chosen in the identity panel is refused without offering "Use for connection", and the real key still logs in afterwards (#986). Test-only; no behavior change.
