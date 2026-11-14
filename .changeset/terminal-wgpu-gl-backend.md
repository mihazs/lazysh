---
"@lazysh/client": patch
---

Record how the wgpu terminal renderer prototype behaves on its OpenGL and OpenGL ES backends compared with Vulkan on the same GPU, as measured evidence for the terminal engine decision (#1323). Measurement and documentation only: the terminal engine is unchanged, xterm.js with its DOM renderer stays the only engine and the default, and no setting or default changes.
