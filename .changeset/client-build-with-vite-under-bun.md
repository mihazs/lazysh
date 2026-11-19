---
"@lazysh/client": patch
---

Build the client with `vite build` under bun instead of `tsc -b && vite build`, so a type error in a test or an e2e fixture can no longer fail a release source build. The `tsc -b` type check stays in `client:check`, which `checks` and the main verdict still run. Build tooling only; no behaviour changes.
