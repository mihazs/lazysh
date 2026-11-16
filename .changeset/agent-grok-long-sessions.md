---
"@lazysh/agent": patch
---

Read long Grok Build sessions in the conversation view: the chunks of a streamed message are joined as they are read and count as one record, so a session of 50,000 chunk records opens instead of being refused at 10,000.
