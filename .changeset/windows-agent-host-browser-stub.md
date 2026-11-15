---
"@lazysh/agent": patch
---

Build the companion for Windows again: the host browser relay's stub for platforms without a browser pipe now has the same return type as the Unix function, so `lazysh-agent.exe` compiles. The relay still answers `HostBrowserUnsupported` on Windows. Nothing released was affected; no defaults change.
