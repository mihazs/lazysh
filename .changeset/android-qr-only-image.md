---
"@lazysh/client": patch
---

test(android): make the QR fixture the only image the Photo Picker can list

The Photo Picker's order put another image first on most runs, so the QR case failed to decode it. The case now removes the other indexed images before staging its fixture. Test only. No user-visible behaviour changes.
