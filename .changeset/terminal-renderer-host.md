---
"@lazysh/client": patch
---

feat(terminal): Add the renderer host that draws a native terminal session on a platform surface

Part of #2215 and #1302. With the optional `native-terminal` feature the app has a renderer host: it draws a core session's frames with the wgpu renderer only when something changed, suspends, survives a lost surface or GPU device, and draws the selection, composing text and the theme and font of the preferences. The renderer can present on a window given as raw handles. Nothing calls the host yet and no released build enables the feature, so terminal behaviour and defaults do not change and xterm.js stays the only engine a user can run.
