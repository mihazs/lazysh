---
"@lazysh/client": patch
---

Extend the Android tmux acceptance case: it now opens a synthetic transcript through the real companion, stages a draft in Chat, and sends it with the explicit Choose, Confirm and Send steps to the pane the attached tmux display shows, and the host reads that pane back by id to require the draft there once and nowhere else, with no extra display client. Test-only; no behaviour changes.
