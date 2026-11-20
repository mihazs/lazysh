---
"@lazysh/client": minor
---

feat(client): name the companion a local session runs in the Agents setup

Name the companion a local session runs (#1667, part of #1132). The Agents setup of a local session shows **Bundled**, **Managed copy** or **On PATH**, from the new `tools.companionSource` that `local_capability` reports for the default target (`null` when no companion resolved). A local session without `lazysh-agent` now says to put it beside the app, install a managed copy or add it to the PATH. No defaults change.
