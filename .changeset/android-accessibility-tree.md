---
"@lazysh/client": minor
"@lazysh/agent": minor
---

feat(devices): inspect and act on an Android device's screen elements from the device controls

Issue #19. **Inspect screen elements** lists what Android's accessibility service reports on the foreground screen (label, class, resource id, bounds and actionable flags, at most 300), and **Tap** and **Long press** act on one element: the host companion (`lazysh-agent devices android ui tree` and `ui act`) re-reads the screen, finds the one enabled element with that identity and touches the centre of its bounds, or fails without touching anything when none matches. The buttons need **Enable device input**. No scrolling, text entry or iOS accessibility yet. Needs the updated host companion. No defaults change.
