---
"@lazysh/client": patch
---

fix(android): keep the Back listener registered so Back never leaves the app while a page opens

Back is handled for the whole session; when nothing is open it runs Android's default Back instead of the app finishing.
