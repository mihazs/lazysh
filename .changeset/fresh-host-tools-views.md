---
"@lazysh/client": patch
---

fix(ssh): refresh host-tool views automatically after the command connection recovers

Herdr navigation, the Agent view, account usage, the multiplexer strip and live transcript watches now refresh on their own when a Mosh or Eternal Terminal session recovers its host-tools connection, and the terminal and session are untouched. The manual host-tools reconnect buttons and credential dialog are removed: while recovery runs the views say host tools are reconnecting, and when it cannot proceed (credentials, a changed host or a jump host) they say why. Reconnecting uploads still uses its own manual flow. Verified with an owned Linux Mosh/Herdr session; Android and iOS acceptance is not yet run.
