---
"@lazysh/client": minor
---

feat(auth): ask before a host sign-in tunnels to this device, with a per-host Ask, Always or Never choice

A banner above the terminal says "Sign-in on <host> needs localhost:PORT" when a login command on an SSH, Mosh or Eternal Terminal host (`aws sso login`, `codex login`, `gcloud auth login`) prints a redirect to the host's `localhost`, and offers Allow once, Always for this host and Deny. Allowing starts the tunnel; tapping the sign-in link in the terminal then opens it on this device (an in-app tab on a phone). Settings, General, Sign-in on hosts, chooses Ask (the default), Always or Never per host, and lists the last 50 sign-ins from memory only. Nothing is tunnelled until you answer or a host is set to Always, and a terminal link whose redirect is the host's `localhost` no longer opens until its tunnel runs.
