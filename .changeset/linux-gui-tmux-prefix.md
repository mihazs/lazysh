---
"@lazysh/client": patch
---

Add Linux native GUI cases for the saved multiplexer prefix: a tmux case that saves a custom prefix, kills and relaunches the app, sends prefix plus a window number to a real tmux server with that prefix and asserts the remote window, then closes the tab and asserts the session and its panes survive; and a Herdr case that does the same with prefix plus a tab number and the server's focused tab. Test infrastructure only; no product change.
