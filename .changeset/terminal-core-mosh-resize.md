---
"@lazysh/client": patch
---

Teach the shared Rust terminal core to apply Mosh display frames as a top-anchored resize without reflow. The core is not wired into the app yet and xterm.js stays the only engine and the default, so nothing changes for users; this is groundwork for trying a native engine behind an explicit opt-in.
