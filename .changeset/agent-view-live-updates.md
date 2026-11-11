---
"@lazysh/client": minor
---

Update the Agent view in real time. A bound Claude Code or Codex conversation now streams over one host companion channel (`lazysh-agent transcript-watch`) instead of a full page read every 2 seconds: new messages, a reply that grows and a tool result that lands on an older turn change their card in place, without a page replace or a jump of the reading position. The thread shows Agent is working or waiting from the recorded turn state, polls every 2 seconds with a note when the stream cannot open, marks the thread stale while it reconnects, and asks you to update an older host companion.
