---
"@lazysh/client": minor
---

feat(rmux): offer to recreate a vanished rmux session when you restore the workspace

When an rmux session is gone, **Restore previous workspace** now offers: **Recreate session** starts it again under the same name on the same rmux server, **Forget saved session** drops it, and a live session still reattaches without a prompt. Checking a saved rmux session never starts an rmux daemon, and a Mosh entry for a missing one is refused before any Mosh server starts.
