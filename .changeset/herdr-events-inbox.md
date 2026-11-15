---
"@lazysh/client": minor
---

Read a Herdr server's changes from the host companion's `herdr-events` stream while a Herdr view is shown, instead of every 5 seconds, with a polling fallback and a note saying which mode is active (English, Portuguese, Spanish), and turn a Herdr agent that becomes blocked or done into an inbox event with the Herdr pane identity and no command text, deduplicated against the same transition reported by a hook.
