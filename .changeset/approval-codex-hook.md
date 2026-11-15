---
"@lazysh/agent": minor
---

Answer Codex's permission prompts remotely through Codex's own `PermissionRequest` hook decision. `lazysh-agent approval-request` and `approval-config` take `--agent codex`; the request is the same immutable, hash-bound record as Claude Code's, listed with `"agent":"codex"`, and an allow or a deny with a message goes back on the hook's stdout, never as keys. A request nobody answers gives no decision, so Codex shows its own prompt in the terminal.
