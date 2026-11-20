---
"@lazysh/client": patch
---

feat(terminal): check the device's GPU before the native terminal engine is offered

The app asks the renderer for a graphics adapter before a session may use the native
engine. A device with only a software rasterizer, with no adapter, or whose driver
takes longer than 2 seconds to answer keeps xterm.js, and the engine line says why.
No release build includes the native engine yet, so nothing changes for users.
Changed defaults: none.
