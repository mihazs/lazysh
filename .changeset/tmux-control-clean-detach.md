---
"@lazysh/client": patch
---

Detach the tmux navigation control client cleanly before closing its SSH channel or transport. On tmux older than 3.8, closing the transport while tmux still had output queued for that client left the client, and therefore the tmux server, running forever after lazysh disconnected. lazysh now ends control mode first, waits up to 500 ms for tmux to confirm, and only then closes the channel.
