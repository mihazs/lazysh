---
"@lazysh/client": patch
---

Add an Android instrumentation case that observes the operating system after a remote OSC 52 request is allowed (the system clipboard) and after Open in browser is tapped on a terminal link (an `ACTION_VIEW` intent for that URL). Test coverage only; no app behaviour changes.
