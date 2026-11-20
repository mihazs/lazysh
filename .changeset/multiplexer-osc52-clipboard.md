---
"@lazysh/client": patch
---

test(multiplexers): verify that a copy in tmux, Zellij and Herdr reaches the device clipboard

Verifies that text copied in tmux, Zellij and Herdr reaches the device clipboard through the OSC 52 consent prompt (#1699, part of #1147), and documents the option each multiplexer needs. No behavior or default change. `native-linux-runtimes` now drives real tmux, Zellij 0.45.1 and stock Herdr clients in the terminal pane, and Windows runs the unit tests of the client's OSC 52 handler.
