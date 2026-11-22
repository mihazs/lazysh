---
"@lazysh/agent": patch
---

fix(herdr): on macOS the Herdr event stream ends cleanly when the Herdr server closes its socket

On macOS the companion's Herdr event stream stopped with `Invalid argument` when the Herdr server closed the socket, instead of ending the stream so the Agent view resubscribes or falls back to polling. The read no longer fails when the platform refuses a timeout on a closed socket.
