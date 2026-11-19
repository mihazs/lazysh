---
"@lazysh/client": patch
---

Add the program workloads of the terminal benchmark suite (W5 vim, W6 tmux and Zellij, W7 Mosh resize and reconnect, W8 agent screens and streaming, W11 background, resume and surface recreation): renderer-neutral replayable workloads built from the recorded captures, an xterm.js page runner and Playwright spec that can also drive an Android WebView on the Waydroid lane, and a native core example that replays the same bytes against the same screens. Test and documentation only; no behaviour changes.
