---
"@lazysh/client": patch
---

test(android): deny the Attachment Photo camera permission through the real system sheet

The owned Mosh attachment case now denies the camera permission and verifies no camera opens, the draft is unchanged and the ordinary file chooser still opens. Test and documentation only. No user-visible behaviour changes.
