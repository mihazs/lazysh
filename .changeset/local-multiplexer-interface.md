---
"@lazysh/client": minor
---

feat(client): show Sessions, Jump To and the multiplexer tab strip in local desktop sessions

When this device's `PATH` has tmux, Zellij or Herdr, `local_capability` reports `tmux`, `herdr` and `zellij` for the default target (never tmux on native Windows), and a local session lists, creates and attaches multiplexer sessions through Sessions, opens Jump To and shows the tab strip and gestures of an attached tmux or Zellij terminal. Attaching opens a new local terminal and the saved workspace keeps it, so Restore previous workspace attaches it again. A local Herdr terminal stays a plain terminal until the Herdr sidebar runs on this device, and a target with no multiplexer keeps Sessions hidden and says why. SSH sessions behave as before.
