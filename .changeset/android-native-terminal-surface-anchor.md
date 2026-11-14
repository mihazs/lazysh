---
"@lazysh/client": patch
---

Add the page side of the developer-only Android native terminal surface: a tracker that keeps the surface on a DOM element through layout, scroll, zoom and transitions, with at most one placement command in flight, no work while the page is idle, and the surface taken down when the element has no box, the shell refuses, or tracking stops. Nothing in the app creates a tracker yet and release builds refuse the commands, so xterm.js stays the only engine and the default and nothing changes for users.
