---
"@lazysh/client": patch
---

feat(terminal): add a build-time kill switch that keeps every session on xterm.js

A build made with `LAZYSH_NATIVE_TERMINAL=off` (read by the client build and by the Tauri build script, so one variable sets both) never selects, probes or creates the native backend whatever the saved engine choice or the developer override says, records `disabled in this build` as the reason with its translation in English, Brazilian Portuguese and Spanish, leaves Native out of the list the Settings choice will show, and leaves the native core out of the app even when it is compiled in. Any other value than `on` or `off` fails the build. Part of #1342 and #1302. No default changes: release builds do not set the variable, so nothing changes for users.
