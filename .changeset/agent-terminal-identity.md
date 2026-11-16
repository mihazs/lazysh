---
"@lazysh/agent": minor
---

Report the identity of a terminal lazysh starts: a hook that runs with `LAZYSH_TERMINAL` set to 32 lowercase hexadecimal characters records `lazysh:<id>` as its pane identity when neither `TMUX_PANE` nor Zellij's variables are set, so a later release can tie the Agent view of a terminal with no multiplexer to the agent that terminal started. A value of another shape is ignored and the hook still succeeds. Nothing exports the variable yet, so reports do not change.
