---
"@lazysh/client": patch
---

fix(agents): show the /model list of Codex 0.172.0 as a native menu in the Agent view

Codex 0.172.0 lists ten models as a window of eight rows with an arrow row where rows are hidden, and numbers only the first nine rows, so the Agent view showed only "The agent is waiting for you in the terminal". The dialog card now reads that window, offers the rows it shows (a choice sends the same arrow keys and Enter as before) and says "More options are in the terminal." for the rest. The shorter lists of earlier versions read as before. No defaults changed.
