---
"@lazysh/client": patch
---

fix(android): reopen Lazysh when the System WebView renderer exits

Android rebuilds the Lazysh interface after its renderer exits, so saved connections remain available for reconnecting.
