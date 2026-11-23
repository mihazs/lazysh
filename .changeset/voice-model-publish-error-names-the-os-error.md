---
"@lazysh/client": patch
---

chore(voice): include the system error when a Whisper model cannot be published

Refs #2468. The import used to say "Cannot publish model; destination may already exist" whatever the system answered to the exclusive link; the message now ends with the system's own error, so a refused link and an existing model can be told apart. No default changes.
