---
"@lazysh/client": patch
---

Probe whether a native surface can sit below the transparent web view on macOS (#1333): a standalone test host builds the real tao and wry window, puts a `CAMetalLayer` view below the `WKWebView` inside wry's `WryWebViewParent`, and a macOS CI job reads the window back from the window server to judge placement, DOM overlap, resize and recreate at 1x and 2x. Test infrastructure only; the app is unchanged and xterm.js stays the terminal on macOS.
