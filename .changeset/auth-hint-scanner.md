---
"@lazysh/client": minor
---

Detect sign-in callbacks in terminal output. When a command on the host (`aws sso login`, `codex login`, `gcloud auth login`, `wrangler login`, `terraform login`, `vault login -method=oidc` and similar) prints an authorize URL whose `redirect_uri` is `http://localhost:PORT`, the native output path now notices it, also while the WebView is suspended, and announces a sign-in hint (port, callback path, identity provider host, whether the URL carries a PKCE challenge) to the app. Colours, hyperlinks, a URL the program wrapped and any chunking of the output are handled; dev-server addresses, redirects to public hosts, ports below 1024 and URLs over 4096 bytes are ignored, and no query value (`code`, `state`) is ever kept. Nothing is tunnelled or opened yet: the hint is only reported.
