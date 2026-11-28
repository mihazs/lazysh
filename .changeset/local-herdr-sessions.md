---
"@lazysh/client": patch
---

feat(herdr): run the native Herdr commands against a local desktop session

The Herdr workspace tree, actions, workspace creation with an optional agent, agent kinds, Git repository read and agent conversation read now run against a local desktop session as argument lists, with the same `PATH` lookup and owner-checked `~/.local/bin` fallback as discovery. Exact pane focus and the conversation read use the local companion and report that it must be installed or updated when it is missing. The interface still hides the Herdr views for local sessions, and SSH sessions behave as before apart from unquoted safe words in the commands sent.
