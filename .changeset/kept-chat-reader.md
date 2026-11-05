---
"@lazysh/client": patch
---

Keep the opened Chat transcript reader, its reading position and unsent draft when returning from the terminal or another session view. Following pauses while hidden, confirmed terminal destinations are still released on leaving, and reported-history readers still retire.
