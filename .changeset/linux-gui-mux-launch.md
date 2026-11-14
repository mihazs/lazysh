---
"@lazysh/client": patch
---

Add Linux native GUI cases for the desktop `--mux` launch: a warm `--host ID --mux tmux:SERVER` launch that opens the connection dialog, authenticates, lists only the named server's sessions in the requested picker and attaches the pre-existing pane, and a `--mux herdr` launch that attaches an owned Herdr server. Test infrastructure only; no product change.
