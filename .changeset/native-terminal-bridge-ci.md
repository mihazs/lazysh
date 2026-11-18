---
"@lazysh/client": patch
---

Compile the app's native terminal bridge with the `native-terminal` feature in CI and run its real-core tests (the local PTY, the 100-session churn, the core's input encoding and the transport cases) in a new `native-terminal-bridge` job, so a change to the terminal core crate that breaks the bridge fails on its pull request instead of reaching `main` unnoticed (#1620). The 100-session churn test now waits for the core to finish parsing a session's last output instead of reading the screen the moment the PTY closes, which failed on a loaded host.
