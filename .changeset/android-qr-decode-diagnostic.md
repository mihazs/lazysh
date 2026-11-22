---
"@lazysh/client": patch
---

test(android): report the page's own read and decode outcomes when the QR image case fails

The QR picker case fails intermittently with "The QR image could not be decoded" although the picker lists only the fixture. The failure now carries the outcomes of the page's file read and decode call. Test only. No user-visible behaviour changes.
