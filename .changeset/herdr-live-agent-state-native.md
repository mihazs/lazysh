---
"@lazysh/client": patch
---

test(herdr): assert live Herdr agent states and the current marker on Android and the Linux GUI

The Android shared-navigation case requires each Agents row to render its real Working or Needs attention state and checks the current space, tab and pane before every Spaces switch. A new Linux GUI case moves the live agent from Unknown to Working to Needs attention and moves the real server focus from the Spaces tree. Test coverage only; no product change.
