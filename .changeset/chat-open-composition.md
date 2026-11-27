---
"@lazysh/client": patch
---

fix(chat): Send and Stop in the Chat terminal input work from an open touch-keyboard composition

Leaving the field ends the open composition first, then Send or Request stop acts once on the committed draft instead of staying disabled.
