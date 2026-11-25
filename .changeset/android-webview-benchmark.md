---
"@lazysh/client": patch
---

fix(bench): connect the terminal benchmark to the Android WebView

The benchmark connects without browser-only defaults and releases its ADB debugger forward when it exits.
