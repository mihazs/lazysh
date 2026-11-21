---
"@lazysh/client": patch
---

feat(linux): draw a native terminal session on the Wayland subsurface with wgpu, native builds only

In builds with the `native-terminal` feature, which no release enables, a session that has a native core is drawn on its Wayland subsurface by the renderer host: GDK's display and the subsurface go to wgpu as raw handles, and the swapchain follows the pane's anchor and the window's scale. Released builds are unchanged: the terminal stays xterm.js.
