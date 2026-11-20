---
"@lazysh/client": patch
---

feat(linux): place a native terminal surface below the web view on Wayland, in builds with the native terminal only

Builds with the `native-terminal` feature, which no release enables, get a Linux surface host: the three surface commands place a Wayland subsurface of the app window below a transparent web view at the pane's anchor, and the device probe refuses native on X11 and Xwayland with the display named. The surface shows the pane background; no renderer draws on it yet. Released builds are unchanged: their window stays opaque and the terminal stays xterm.js.
