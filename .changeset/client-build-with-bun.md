---
"@lazysh/client": patch
---

Build the client with Bun (`bun build/build.ts`: Bun transpiles the TypeScript and bundles it, with code splitting) instead of `tsc -b && vite build`, so the build is much faster and a type error in a test or an e2e fixture can no longer fail a release source build. `tsc -b` now only type-checks, in `client:check`, which `checks` and the main verdict still run. Vite stays the dev server and the Vitest and Playwright runtime. Build tooling only; the app's behaviour does not change.
