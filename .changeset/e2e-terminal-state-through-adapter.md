---
"@lazysh/client": patch
---

Read terminal state through the TerminalAdapter in the terminal end-to-end specs (#1703): a new Playwright fixture (`e2e/fixtures/terminalState.ts`) takes rows, viewport, selection, geometry and the input element from the adapter of the terminal on screen, and `terminal-ime`, `terminal-swiftkey`, `terminal-selection`, `terminal-clipboard`, `herdr-switch-tap` and `mosh-resize` use it instead of xterm's `.xterm-*` DOM. Test code only; no product behaviour changes, and the specs keep every assertion and pass unchanged on xterm.js at the desktop and phone viewports.
