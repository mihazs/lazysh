---
"@lazysh/client": minor
---

Add the sign-in tunnel engine: a loopback listener on the host CLI's callback port that forwards one checked browser request per connection to the host over the session's SSH connection, with a request guard, per-host consent policy, caps and a one-shot lifetime. Groundwork for automatic SSO sign-in from the device (#1504); nothing in the app starts a tunnel yet.
