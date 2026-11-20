---
"@lazysh/client": minor
---

feat(rmux): discover, attach and use rmux sessions with the tmux tools

Sessions lists rmux next to tmux, Herdr and Zellij, browses a labelled rmux server (tree, new session, rename, windows, panes, split, zoom), attaches it as a terminal, restores it and opens it from `--mux rmux[:LABEL]`. rmux is admitted from `rmux capabilities --json` and probed with `-N`, so discovery never starts a daemon; it is Limited until Jump To and confirmed Chat input are verified on a real rmux. No defaults changed: tmux commands, defaults and saved workspaces are unchanged.
