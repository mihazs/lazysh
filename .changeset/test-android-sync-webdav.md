---
"@lazysh/client": patch
---

Add an owned Android emulator case for encrypted sync (#1540, child of #17): through the real Sync panel it enrolls against an owned HTTPS WebDAV server, shows the recovery key again from the native credential store after a restart, checks that nothing is uploaded before the explicit action and that credentials stay off, uploads settings as age ciphertext, then enrolls a reset install with the recovery key and previews and applies the saved host list. Owned emulator builds trust one extra root for `127.0.0.1` through the `sync-tls-acceptance` Cargo feature; published builds do not compile it, and production sync still requires HTTPS with the web PKI roots. Test infrastructure only.
