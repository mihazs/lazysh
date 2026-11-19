---
"@lazysh/client": patch
---

Run the six named terminal end-to-end specs per terminal backend (#1703): `LAZYSH_E2E_TERMINAL_BACKEND=xterm|native bun run test:e2e:terminal` sets the developer override before the page loads and `onAdapter` fails the spec when the terminal on screen is another backend, so a silent fallback cannot pass as the requested engine. CI runs the xterm arm and a native arm that is reported skipped, with the backend registry's reason, until the native backend is registered. Test code and CI only; no product behaviour changes.
