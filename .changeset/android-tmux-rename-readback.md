---
"@lazysh/client": patch
---

Pin the Android tmux acceptance case's host readback for the window rename: a real-tmux test requires it to refuse a rename that reached an original window and an original pane that was replaced, and the parity matrix records that the create, rename and close step ran green on `main`. Test and documentation only; no behaviour changes.
