---
"@lazysh/client": patch
---

Record whether a native terminal surface can sit next to the app's web view on Linux (#1331, part of #1302): a prototype and its measurements on Wayland and X11, kept outside the app. Nothing changes for users: xterm.js stays the only engine and no setting or default changes.
