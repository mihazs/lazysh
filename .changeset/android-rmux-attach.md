---
"@lazysh/client": patch
---

Verify through the real Android app that an rmux session on the owned host is discovered as Supported, attached with Browse rmux sessions, switched between windows with Jump To and the numbered control, and reattached after its tab closes, with host checks that the original rmux server and pane processes survive. The owned tmux job runs the tmux and rmux cases as separate tests, each with its own results directory.
