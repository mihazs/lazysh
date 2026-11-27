---
"@lazysh/client": patch
---

fix(settings): show Use Option as Meta only on macOS

The setting is listed only where the app reports it runs on macOS, so Android, iOS, Windows and Linux no longer list a macOS-only key. When the app cannot report its OS, the setting stays listed.
