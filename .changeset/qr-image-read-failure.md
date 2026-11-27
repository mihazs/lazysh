---
"@lazysh/client": patch
---

fix(theme): say the QR image could not be read instead of blaming decoding

When the page cannot read the chosen QR image file, the error now asks you to choose it again rather than saying the image could not be decoded.
