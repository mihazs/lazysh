---
"@lazysh/client": patch
---

test(android): pick the QR fixture first in the Photo Picker and tap the Chat composer where it is not covered

The QR picker case could choose another image, so the page failed to decode it, and the Chat composer CJK step tapped the centre of a composer that the phone's key bar covered. Test only. No user-visible behaviour changes.
