---
"@lazysh/client": patch
---

test(android): choose the QR fixture in the Photo Picker that API 36 opens for image inputs

The QR picker case looked for the fixture by file name, but an image input opens the Photo Picker, which names no file. The case now takes the newest tile. Test only. No user-visible behaviour changes.
