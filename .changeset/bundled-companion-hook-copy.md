---
"@lazysh/client": patch
---

Bind local agent hooks to a lasting copy of the bundled companion (#1666, part of #1132). Hook setup (status, install and remove) in a local session now first places an owner-only copy of the `lazysh-agent` beside the app in the managed directory (`<data>/lazysh/companion/`), written to a new file and renamed into place, and runs from there, so the hooks it writes keep working after the app exits; an AppImage runs the bundled companion from a mount that disappears with the app. A managed copy that is the user's own and at least as new as the bundled version is kept; an older or unsafe one is replaced. Discovery and every other command keep running the bundled companion, a companion found at the managed path or on the `PATH` is used as it is, and Windows (template-only hook setup) is unchanged. No defaults change, and nothing ships a bundled companion yet, so nothing changes for an install today.
