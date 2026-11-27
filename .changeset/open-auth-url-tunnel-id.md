---
"@lazysh/client": minor
---

feat(auth): open a sign-in page only for the live tunnel of its own session

`open_auth_url` now takes the `sessionId` and the `tunnelId` that `start_auth_tunnel` returned, and refuses a `localhost` redirect unless that flow is live on exactly that port, so another program that took the port first no longer passes. A local session keeps the listener check. No visible change yet: nothing in the app calls the command (#1520).
