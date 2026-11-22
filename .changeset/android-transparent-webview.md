---
"@lazysh/client": patch
---

feat(terminal): let the Android WebView show a native terminal's surface while one is placed

Part of #1327. On Android the native terminal draws on a surface below the WebView, which painted its own opaque background over it. The WebView is now transparent while at least one native pane is placed and opaque again when none is, so a native pane's surface shows through where the page paints nothing and the page's overlays stay above it. An xterm.js session never places a surface, so nothing changes for it. The native engine is still opt-in (Settings, Terminal engine) and Auto never selects it.
