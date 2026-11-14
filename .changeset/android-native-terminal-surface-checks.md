---
"@lazysh/client": patch
---

Check the developer-only Android native terminal surface host on a device for what a terminal pane needs from it besides drawing: it follows the cutout and keyboard insets with the page, keeps its surface while its window is only paused, is resized and not recreated by a rotation, and a touch over it reaches the page and never the surface. Developer builds only and tests plus documentation: nothing in the app calls the surface yet, so xterm.js stays the only engine and terminal behaviour does not change.
