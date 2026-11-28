---
"@lazysh/client": patch
---

fix(agents): show the rows of a dialog the Agent view cannot answer, instead of a one-line banner or nothing

When an agent opens a dialog the dialog card cannot read exactly (tabs, a search box, a full-screen table such as Claude Code's /permissions and /login or Codex's /resume), the Agent view now shows the dialog's own rows as read-only text above "Show terminal", so you can see what the agent asks. Claude Code's /config, which showed nothing, now shows the same, and the message box is held while it is open. Nothing is sent from those rows. No defaults changed.
