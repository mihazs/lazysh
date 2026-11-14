---
"@lazysh/client": patch
---

Fix the installed Windows GUI check so it can run: its composite action carried a `timeout-minutes` key the runner refuses, so the action failed to load on `main` and the `continue-on-error` step reported success without executing a single case. The 30-minute bound now sits on the workflow step, and a test rejects any composite step key the runner does not accept. Test-only; the application is unchanged.
