---
"@lazysh/agent": patch
---

fix(agent): give a cold Firefox as long to start as Chrome before the host browser relay gives up

The Firefox adapter ended a session with `BrowserStartTimeout` after 30 seconds without the browser's port, while the Chrome launcher and relay wait 90 seconds. A Firefox starting on a loaded host could miss the shorter limit. Both now wait 90 seconds, and the closing message of a Firefox that never listened carries how long the relay waited.
