---
"@lazysh/client": patch
---

Keep the Playwright e2e fixtures out of the `src` type-check that the release source build runs. The terminal backend selection and `onAdapter` now live in a Playwright-free module under `src`, so the F-Droid build, which removes `playwright-core`, type-checks again; the terminal e2e specs behave as before. Internal build fix: no behaviour changes for users.
