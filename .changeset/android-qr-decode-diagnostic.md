---
"@lazysh/client": patch
---

test(android): wait until the staged QR fixture's MediaStore row stops changing before the picker opens

The QR picker case failed intermittently with "The QR image could not be decoded": the page's own read of the chosen file rejected with NotReadableError, which Chromium raises when a file's size or modification time changed after it was chosen, and MediaProvider rewrites a published file's row after it leaves pending. The case now waits for the row to stay unchanged first, and a failure still reports the page's read and decode outcomes. Test only. No user-visible behaviour changes.

A case that blocks now fails after 7 minutes (runner argument `timeout_msec`, was 15), because once one case wedges the app every later case waits out its own limit.

If the page's read of the chosen image is refused once with NotReadableError, which Chromium raises when the file changed after it was chosen, the case chooses the image again once and still requires the decoded preview.
