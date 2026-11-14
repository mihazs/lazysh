---
"@lazysh/client": minor
---

Answer the questions and dialogs of the agent followed in a Zellij pane from the Agent view, as on tmux and Herdr. The host reads the agent's own pane (`zellij action dump-screen --pane-id`, new read-only command `zellij_agent_screen`) because the terminal shows Zellij's composite screen, the dialog card shows the list dialog that is open (`/model`, `/resume`, the trust prompt, the plan decision, Codex's approval prompt), and a tap sends the arrows and Enter a person presses with Zellij's own `send-keys`, which writes an arrow for the cursor-key mode of that pane, after reading the highlight back. A Claude Code question is answered with its option's digit, or a typed line and its Enter, through the same input. The host proves the pane runs the agent before every key.
