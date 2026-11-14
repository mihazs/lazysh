---
"@lazysh/client": minor
---

Show the Agents board, transcripts, usage reports, approvals and notification inbox for a local session (#1667, part of #1132). Local sessions share one host key, `local:default`, and the label **This device**, so their reports group, archive and notify like a saved host's, and every local tab on the target is polled once. The views appear when the local target reports the companion (`tools.companion`); a target without it hides them and the session details say that `lazysh-agent` was not found on this device. The companion panel offers no SSH install for a local session, and hook discovery and setup reach the local companion. Remote sessions, saved hosts and their polling are unchanged; no default changes.
