---
"@lazysh/agent": minor
---

Update the host companion by itself when a newer lazysh app connects. An app now sends its version in `LAZYSH_APP_VERSION` on every command it runs; a companion that is older than that app, under the new `lazysh-agent auto-update` policy `install` (the default), starts one detached `lazysh-agent update --yes --version <the app's version>` in the background, replies to the request as usual with an `update` field in `snapshot`, never downgrades, never updates during an active agent turn, runs one update at a time and backs off after a failure. `lazysh-agent auto-update status` and `set --expected-revision R --policy off|notify|install` show and change the policy.
