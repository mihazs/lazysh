---
"@lazysh/client": patch
---
test(android): prove the tmux pane restores only on click after a force-stop and relaunch


Verify through the real Android app that a force-stopped and relaunched app offers "Restore previous workspace" only on click and then reattaches the same tmux pane with the saved credential. The owned tmux job runs it as two instrumentation processes with a host force-stop between them.
