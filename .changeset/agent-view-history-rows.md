---
"@lazysh/client": patch
---

fix(agents): show what the agent said in a long turn and fill the Agent view with earlier messages

The Agent view folded everything between a prompt and its closing answer into one row, so a session that worked for hours on one prompt was two rows ("Thought for…", "Ran 83 commands") and loading earlier messages only made the count larger. What the agent says between its tool calls is now shown as messages, with the work between them folded. When the newest page does not fill the view, earlier pages are read until it does, and the view stays at the newest message.
