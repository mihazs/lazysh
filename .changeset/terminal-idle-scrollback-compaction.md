---
"@lazysh/client": patch
---

Compact the scrollback of native terminal sessions nobody is looking at (#1338): a session with no view attached that has received nothing for two seconds has its history compressed by libghostty-vt in small steps on an idle worker, and it is restored on access. On one desktop host a full session went from about 4 MiB to about 0.5 MiB resident and ten sessions from about 40 MiB to about 8 MiB when nine were idle, with the history unchanged. The native core is not the default engine: xterm.js stays the default, and no setting or default changes.
