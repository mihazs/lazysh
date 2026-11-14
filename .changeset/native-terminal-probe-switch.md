---
"@lazysh/client": patch
---

Register the native terminal engine behind a capability probe, a build-time kill switch and the developer override, and add the mid-session switch back to xterm.js. The probe fails in every build today (the app has no native renderer), so xterm.js is always chosen and nothing changes for users; a developer who asks for native is told why they got xterm.js.
