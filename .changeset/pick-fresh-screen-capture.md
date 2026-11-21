---
"@lazysh/client": patch
---

feat(agents): send a dialog's keys only after the host reads the pane again and finds that dialog once

Answer an agent's list dialog from the Agent view only after the host reads the pane again: each arrow, Enter and dialog Cancel now carries the rows of the dialog the card was read from, and the app sends no key unless the pane, captured right before it, still shows exactly that dialog once. A dialog answered at the terminal first, replaced by another prompt in the same pane, drawn twice or gone gets nothing and the card says the dialog changed; the connection stays usable. The fresh capture is tmux's: a pane followed through Herdr or Zellij is answered after their own destination check, as before.
