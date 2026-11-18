---
"@lazysh/client": patch
---

Add a developer-only native terminal surface host to the Android app: a `SurfaceView` stacked below the page that a native terminal engine will draw on, placed from a DOM element and kept across stop and start and Activity recreation. Release builds refuse every command and nothing in the app calls it yet, so xterm.js stays the only engine and the default and nothing changes for users; this is groundwork for the Android native-engine opt-in.
