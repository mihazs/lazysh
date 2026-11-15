---
"@lazysh/client": patch
---

Make the client's unit tests compile on Windows again: the ConPTY lifecycle test called `desktop::connect` without the `attach` argument added with local multiplexer attach, so no Windows step that builds the client library tests could run (#1905). Test-only; no user-visible change.
