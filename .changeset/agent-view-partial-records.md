---
"@lazysh/client": minor
"@lazysh/agent": minor
---

feat(agents): show a Copilot CLI, Kimi CLI or Droid session's records in the Agent view, labelled as partial

A GitHub Copilot CLI, Kimi CLI or Droid pane that reports a session now shows that session's records in the Agent view: read-only, under a partial label, with the hook state in the header and Show terminal. The companion's `discover` names `sessionId` for these three adapters (additive). Agents the view cannot read (Pi, OMP, Hermes, Cursor, Amp, Grok Build) now say that the view shows only their last reported state instead of pointing at a setting that cannot fix it. No defaults change. Refs #1658, #1125.
