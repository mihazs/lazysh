---
"@lazysh/client": patch
---

Prepare keyboard parity for a native terminal engine on macOS, Windows and Linux: a key mapping that sends characters typed with Option or AltGr as characters, Option as Meta as Meta, and Option+Left and Option+Right as word movement on macOS, checked against what xterm.js sends on each platform. xterm.js stays the only engine and nothing offers another one yet, so terminal behaviour and defaults do not change.
