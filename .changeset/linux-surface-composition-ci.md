---
"@lazysh/client": patch
---

Run the Linux native surface composition probe in CI: a new `native-linux-surface` job builds `packages/terminal-runtime/prototypes/linux-surface` and runs its checks under a headless sway compositor (pixels read back with grim) for `wl_shm` and a wgpu Vulkan swapchain on lavapipe at scale 1 and 2, and on Xvfb for X11, asserting exact anchor pixels, overlap, resize and recreate. CI and prototype only; no behaviour changes.
