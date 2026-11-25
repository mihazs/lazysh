---
"@lazysh/client": patch
---

test(android): verify rmux SSH fixtures alongside tmux

Run the owned Android tmux job's host cases against the pinned rmux 0.10.0 release as well as tmux: the owned fixture serves a two-window rmux session, and the SSH detach and reattach, the control-client teardown through the server and the stalled-client retirement are checked for both. The job installs the checksum-verified rmux release for them.
