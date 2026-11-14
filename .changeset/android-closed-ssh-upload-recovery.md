---
"@lazysh/client": patch
---

Extend the Android Mosh attachment acceptance case: the owned device now reaches its SSH daemon through the owned relay, the host closes only the app's SSH stream (server-attributed) while the Mosh daemon stays alive, and the real UI shows the closed-control upload error with its Reconnect uploads action, restores uploads by manual authentication without an automatic upload or a second terminal, and then uploads the exact bytes by a separate explicit Upload (a repeated Upload leaves the file untouched). Test-only; no behaviour changes.
