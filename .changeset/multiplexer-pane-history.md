---
"@lazysh/client": minor
---

Read the scrollback of the pane you are viewing from the multiplexer on the host. A new **Pane history** section in the Sessions panel of an attached tmux, Zellij or Herdr terminal fetches the history from the multiplexer itself (tmux `capture-pane`, Zellij `dump-screen --full`, Herdr `pane read`), so it no longer depends on the terminal's own buffer or on tmux copy mode, and shows it read-only with a line search and **Copy these lines**. It keeps the newest 20,000 lines or 2 MiB and says when older output was left out; Herdr serves at most its newest 1,000 lines. New command `multiplexer_history`; the capability record's `history` entry is missing for Zellij older than 0.45 and for Herdr outside 0.9.3 to 0.9.5. No defaults change.
