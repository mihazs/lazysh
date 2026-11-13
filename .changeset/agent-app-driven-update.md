---
"@lazysh/agent": minor
---

Update the host companion by itself when a newer lazysh app connects. A companion that is older than the app that talks to it (the app says which version it is in `LAZYSH_APP_VERSION`, set on every command it runs), under the new `lazysh-agent auto-update` policy `install` (the default), starts one detached `lazysh-agent update --yes --version <the app's version>` in the background and replies to the request as usual, with an `update` field in `snapshot`. It never downgrades, never updates during an active agent turn, runs one update at a time and backs off after a failure. `lazysh-agent auto-update status` and `set --expected-revision R --policy off|notify|install` show and change the policy.
