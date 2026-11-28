---
"@lazysh/client": patch
---

test(herdr): verify Spaces layouts, pane focus and agent-to-pane navigation on a real Herdr server

Native acceptance now covers the Herdr Spaces layouts, pane focus and agent-to-pane navigation against a real stock Herdr server in the native acceptance: the Android shared-navigation case picks accordion, grid and list through the real selector and checks the stored preference, that a display whose sidebar mounts fresh shows it, and the exact target, and a new Linux GUI case does the same in the actual window, focuses a pane and an agent pane through each layout, and opens an Agents row on its exact pane with the workspace, tab and folder the server reports. Test coverage only; no product change.
