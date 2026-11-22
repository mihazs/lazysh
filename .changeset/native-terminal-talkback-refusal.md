---
"@lazysh/client": patch
---

feat(android): Keep the native terminal engine off while TalkBack or another screen reader is on

Part of #1329. A new terminal session on Android uses xterm.js, and Settings shows Native as turned off with the reason, while Android reports a screen reader: touch exploration (TalkBack) or an enabled service that speaks or brailles the screen. This used to depend on the in-app Screen reader announcements preference alone. Settings asks again when you return to the app. A session that is already open keeps its engine. Only an explicit Native choice reaches the native engine today, so nothing changes for Auto or xterm.js.
