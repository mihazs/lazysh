---
"@lazysh/client": patch
---

test(windows): drive theme QR scan and shell link import through the installed GUI

The installed Windows GUI check now scans a QR image through the real file input and opens a `lazysh://theme` link through the Windows shell with the registration the NSIS installer wrote; the theme changes only after Apply. Test-only; the application is unchanged.
