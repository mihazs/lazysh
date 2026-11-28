---
"@lazysh/client": patch
---

test(desktop): run the local companion cases against the packaged macOS app and the installed Windows app

Not a debug build beside the test executable (#1853, part of #1666). `native-desktop` now builds the companion in release mode, stages it as the app's bundled sidecar and packages the macOS app and the Windows installer the way a release does. The macOS case runs `lazysh-agent` from the built app's `Contents/MacOS`; the Windows cases install the NSIS package, repair it, run the board, transcripts and settings case and the template-only hook setup case against the install directory (`LAZYSH_TEST_BUNDLE_DIR`), check the local arm resolves to that file and uninstall; the same cases must fail against a folder without the companion. The Windows step is non-blocking until its first hosted pass. Test and CI infrastructure only; the app and its defaults are unchanged.
