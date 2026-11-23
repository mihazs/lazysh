---
"@lazysh/client": patch
---

fix(voice): import a Whisper model on Android, where hard links in app storage are refused

Fixes #2468. Importing a model published it with an exclusive hard link, which Android's storage policy refuses with "Permission denied", so every import ended with "Cannot publish model; destination may already exist". The link is still tried first; when it is refused for permission, the model is copied into a file created exclusively, so an existing model is still never replaced. The message of any other failure now ends with the system error.
