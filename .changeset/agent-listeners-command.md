---
"@lazysh/agent": minor
---

Add `lazysh-agent listeners [--port N]... [--json] [--watch]`, which lists the TCP listeners on loopback or a wildcard address with their owner process id, name, user and start time (Linux `/proc`, macOS and other Unix `lsof`, Windows `Get-NetTCPConnection`) and prints `listen` and `close` events with `--watch`. The app uses it to confirm that the `http://localhost:PORT` a sign-in command printed is served by the host's own process. It reads no arguments or environment and tunnels nothing.
