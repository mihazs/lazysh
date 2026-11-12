---
"@lazysh/client": minor
---

Answer the list dialogs Claude Code opens (`/model`, `/resume`, `/rewind`, the folder trust prompt, the plan decision) from the Agent view on a tmux session: the dialog is read from the pane's terminal screen, shown as a card, and a choice is sent as arrow keys, a read-back and Enter through a new bounded `pick` input of the confirmed terminal input.
