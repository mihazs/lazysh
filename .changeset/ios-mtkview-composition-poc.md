---
"@lazysh/client": patch
---

Add the iOS native surface composition proof of concept: a standalone simulator host stacks an `MTKView` below a transparent `WKWebView` and an XCUITest in the iOS simulator job reads placement, DOM overlap, touch routing, scrolling, keyboard resize, safe areas, rotation and lifecycle from the composited pixels. Test-only; the app, its web view and its capabilities are unchanged.
