---
"@lazysh/client": patch
---

test(share): verify the share thumbnail fetch against the real share service

A desktop test uploads a PNG to the real service router behind a throwaway-certificate TLS front, fetches it back through the client's thumbnail download, decodes it to a preview with the original dimensions, and sees the fetch refused once the share is deleted (#994, #1738). Test infrastructure only; the app is unchanged.
