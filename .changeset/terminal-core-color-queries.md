---
"@lazysh/client": patch
---

Teach the shared Rust terminal core to answer the colour queries programs send to pick a light or dark scheme (default foreground, background and cursor with `OSC 10`, `11` and `12`, and the palette with `OSC 4`) from a theme in its configuration, with the replies xterm.js gives (#1314). The core is not wired into the app and xterm.js stays the only engine and the default, so nothing changes for users; this removes one recorded difference before a native engine can be offered as an opt-in.
