---
"@lazysh/agent": minor
---

Answer Copilot CLI's permission prompts remotely through Copilot's own `permissionRequest` hook decision. `lazysh-agent approval-request` and `approval-config` take `--agent copilot`; the request is the same immutable, hash-bound record as Claude Code's and Codex's, listed with `"agent":"copilot"`, and an allow or a deny with a message goes back at the top level of the hook's stdout, never as keys. Copilot runs this hook before its own rules, so every shell command and file edit that needs a permission check waits for you (including ones Copilot would run without asking), and an allow skips Copilot's deny rules. A request nobody answers gives no decision, so Copilot shows its own prompt in the terminal.
