---
"@lazysh/client": patch
---

fix(terminal): say why a native terminal cannot draw and move to xterm.js instead of showing a blank pane

Part of #2457. On Android the native engine could place its pane and then show nothing, with no sign of why (a renderer that could not draw on the surface left only the pane's background). The shell now reports, with the surface's state, whether the renderer drew on it and the reason when it did not; the page reports that reason and the session moves to xterm.js, as it does for a surface the shell cannot place. Every stage of the renderer's way to a first frame is also written to logcat under the tag `lazysh-native`. The native engine is still opt-in (Settings, Terminal engine).
