---
"@lazysh/client": patch
---

fix(account-usage): stop a stalled Windows credential store from holding the Cline quota check

The Cline store is now read on its own thread with a 3 second deadline: a file on an unreachable share or a cloud placeholder that never finishes downloading is reported as "not signed in" instead of keeping the collection waiting, Windows is asked to cancel the pending read, and at most four such reads can be left behind. The opened file must also be a disk file, so a path replaced by a pipe or device is refused. Cancellation is best effort: it bounds how long the check waits and how many threads it can strand, not the Windows request itself. Linux and macOS are unchanged. Following the Cline profile environment variables on Windows is tracked in #1748 and stays unavailable. No defaults change.
