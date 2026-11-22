---
"@lazysh/client": patch
---

fix(herdr): choosing a space, tab or agent waits for a terminal input already in progress

Tapping a row in the Herdr Spaces or Agents list while a terminal input was being delivered failed with "Herdr terminal input is already in progress" and the focus did not move. The change now waits for that input to finish (up to 10 s) before moving the view; a turn that never ends still reports the busy message.
