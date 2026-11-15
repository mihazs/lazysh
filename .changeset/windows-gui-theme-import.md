---
"@lazysh/client": patch
---

Drive theme import in the installed Windows GUI check: a QR image chosen through the real file input is decoded natively into the "QR fixture" preview, and a `lazysh://theme` link opened through the Windows shell (`rundll32 url.dll,FileProtocolHandler`) with the protocol registration the NSIS installer wrote offers "Review linked theme"; in both, the theme changes only after Apply. Test-only; the application is unchanged.
