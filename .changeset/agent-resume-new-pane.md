---
"@lazysh/client": minor
---

Resume an earlier Agent view session in a new pane: under tmux, Zellij and a Herdr with the launcher, **Resume in a new pane** reviews and then starts the agent's own resume command (`claude --resume <id>` or `codex resume <id>`) in a new window, pane or workspace of the session's folder, and the Agent view follows it. Without a launcher, **Resume in the terminal** still stages the command.
