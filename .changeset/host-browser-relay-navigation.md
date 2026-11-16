---
"@lazysh/agent": patch
---

feat(browser): carry navigation, tabs, dialogs and notices over the host browser relay

Teach the host browser relay (`lazysh-agent host-browser serve`) navigation, tabs and a page's dialogs: `navigate`, `back`, `forward`, `reload`, `stop`, `tabs`, `activateTab`, `newTab`, `closeTab` and `answerDialog` become the browser's allow-listed calls, and the relay reports the tab list, the page's dialogs and a denied download or file chooser. An address that is not `http`, `https` or `about:blank`, a tab the browser does not have and an answer with no dialog open are refused and counted. The command is still hidden and nothing in the app sends these messages yet.
