---
"@lazysh/agent": minor
"@lazysh/client": minor
---

Install, update and remove the Kimi Code 2.4 approval hooks from Agent hook setup. The host companion appends an owned `[[hooks]]` block to the end of an existing `config.toml` (never creating it, and keeping every earlier byte) and removes only that exact block; the app requests discovery schema 4 first and falls back for older companions, which keep Kimi manual. No default changes.
