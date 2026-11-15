---
"@lazysh/agent": minor
---

Focus a Herdr pane from the host companion on a Windows host: `lazysh-agent herdr-focus-pane` sends its single `pane.focus` request over the named pipe Herdr listens on instead of reporting the platform as unsupported, after validating the reported path.
