---
"@lazysh/agent": minor
---

feat(companion): stream a Herdr server's agent-status changes with `lazysh-agent herdr-events`

`lazysh-agent herdr-events --session NAME` is a long-lived stream of a Herdr server's agent-status changes over `events.subscribe` (frames `hello`, `status`, `changed`, `heartbeat`, `end` and `unsupported`). A frame names the pane, workspace, agent kind and directory and never a title, command or screen text; a Herdr that cannot stream is reported as `unsupported`. It ends when its input closes and starts nothing on the host. Nothing in the app reads it yet and no defaults change; an update of the host companion is needed to have the command.
