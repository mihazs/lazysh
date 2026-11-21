---
"@lazysh/agent": patch
---

fix(agent): keep the transcript-watch heartbeat on time while the stream waits after a slow projection.

After re-reading a very large transcript the stream waits three times as long as the read took before it checks the file again, and it sent no heartbeat during that wait. A read of a few seconds therefore left the channel silent for longer than the documented 5 seconds, and a longer one could reach the 20 seconds after which the app treats the stream as dead. Heartbeats are now sent every 5 seconds during the wait.
