---
"@lazysh/client": minor
---

Answer the list dialogs of Claude Code and Codex from the Agent view under Herdr, as on tmux: the `/model` and `/resume` pickers, the trust prompt, the plan decision and Codex's approval prompt. The Agent view reads the followed agent's pane through Herdr (`agent read`), shows the dialog as a card, and answers with the arrows and Enter a person presses through Herdr's own `agent send-keys`, reading the highlight back before Enter. The agent's report names what it waits for, so a permission request or a question keeps its own card. The header of a blocked Herdr agent now says what it waits for and since when. A typed free-text answer to a question under Herdr now picks the free-text row and goes to the pane as one literal line and its Enter.
