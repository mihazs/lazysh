---
"@lazysh/client": patch
---

test(android): sample the glass chrome material in the Android WebView

Adds an Android runtime case that samples the glass chrome material in the Android WebView (#1723): for the Workspace tools dialog and Preferences it reads the computed `backdrop-filter` and translucent background and the conditions under which they fall back to opaque, then lays a black and white underlay beneath the dialog and measures the device screenshot across its edge, so a blur or translucency that the WebView declares but does not composite fails it. Test infrastructure only; the app is unchanged.
