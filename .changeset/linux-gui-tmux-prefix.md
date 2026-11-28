---
"@lazysh/client": patch
---

test(desktop): verify the saved tmux and Herdr prefix and numbered controls in the Linux GUI

Two Linux native GUI cases save a custom prefix, relaunch the app, press a numbered window or tab control and assert the real server's window index or focused tab. The tmux case then closes the tab and asserts the session and its panes survive. Test infrastructure only; no product change.
