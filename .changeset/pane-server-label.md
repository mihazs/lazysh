---
"@lazysh/agent": minor
"@lazysh/client": patch
---

Record which tmux or rmux server a hook's pane belongs to. A pane id such as `%7` is unique only inside one server, so a report from `tmux -L work` and one from the default server could carry the same id; the companion now adds `paneServer` (`tmux:work`, `rmux:default`) read from the `TMUX` or `RMUX` socket path, the Agents panel's report details show it, and a socket given with `-S` records none. The field is optional in the snapshot, so an older companion or client works unchanged.
