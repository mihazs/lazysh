---
"@lazysh/client": patch
---

Add an Android emulator case on the pinned Zellij 0.45.1 (new `native-android-zellij` job, `bun run test:android-zellij`): through the packaged UI the app discovers Zellij, lists the one owned session, attaches it, switches to Tab 2 and Tab 1 from the Zellij controls, detaches by closing the tab and reattaches it, while the host reads the session's active tab back with `zellij action list-tabs --json` and checks that both command panes started exactly once. The SSH test fixture gained a pinned-Zellij option. Test-only; no behaviour changes.
