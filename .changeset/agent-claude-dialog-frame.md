---
"@lazysh/client": patch
---

fix(agents): show the /model, /theme and /rewind dialogs of Claude Code 2.1.326 as native menus in the Agent view

Claude Code 2.1.326 redrew its dialogs, so the Agent view showed only "The agent is waiting for you in the terminal" for them. The dialog card now reads the new drawing (the row of `▔` above a dialog, digits followed by two spaces, the "More models" row and footers wrapped over two rows) as well as the previous one, and a choice sends the same arrow keys and Enter as before. A dialog the card still cannot read exactly (tabs, a search box, a list of one item) shows the same banner. No defaults changed.
