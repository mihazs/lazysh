---
"@lazysh/client": minor
---

feat(herdr): mark the Spaces row this device's own guarded client shows as current

Issue #591. Stock Herdr only reports the server's shared focus, which another connection can move, so the marker still follows that focus there. With the optional guarded Herdr host attached, the attached client reports its own workspace, tab and pane, and Spaces marks those instead, but only when the report names the server being read; while a Chat turn holds the guard the last reading is kept, and without the guard the marker returns to the shared focus. Needs a guarded Herdr host; it is built from the repository and not distributed yet (#1522). Real two-client acceptance on a device is not part of this change. No defaults change.
