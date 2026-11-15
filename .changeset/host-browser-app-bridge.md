---
"@lazysh/client": minor
---

Add the app's bridge to the host browser relay: six Tauri commands (`host_browser_start`, `host_browser_next`, `host_browser_ack`, `host_browser_pause`, `host_browser_resume`, `host_browser_stop`) run `lazysh-agent host-browser serve` on one SSH exec channel and hand the viewer its frames as bytes, one pull at a time. A browser stops, and its channel closes, on stop, lock, a dropped connection and the end of the session; one runs per session and two per app. A companion without the relay, or with the host browser switch off, is named and never retried, and nothing about a page is written to a log or to storage. Nothing in the app calls the commands yet: the viewer ships in the next slice of the same feature.
