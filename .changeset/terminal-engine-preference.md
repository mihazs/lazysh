---
"@lazysh/client": patch
---

Remember a per-device terminal engine choice (Auto, Native or xterm.js) and record, for every new session, which engine it got and why, with the reasons in English, Brazilian Portuguese and Spanish (#2092, first slice, part of #1302). New sessions ask the registry for the saved choice, the developer override still wins, and an open session keeps its engine. The choice is never part of encrypted sync. There is no Settings control yet and only xterm.js is registered, so every choice runs xterm.js and nothing changes for users; no default changes.
