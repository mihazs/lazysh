---
"@lazysh/client": patch
---

Verify through the real Android app that a cut SSH route shows the lost-connection banner, that automatic retries are refused while it is down, that the banner closes and the same tmux pane returns when the route comes back with saved credentials, and that Close ends the session without reconnecting. The owned tmux job runs it against a relay the host can cut.
