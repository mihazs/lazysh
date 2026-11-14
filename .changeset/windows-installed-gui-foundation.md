---
"@lazysh/client": patch
---

Add a hosted Windows check that installs the packaged NSIS application, drives its real WebView2 window through the pinned `tauri-driver` 2.1.0 and the official Microsoft EdgeDriver that matches the installed runtime, verifies the installed image, native window and bundled About version and source revision, bounds shutdown, and uninstalls cleanly. Test infrastructure only; the application, its defaults and the release artifacts are unchanged.
