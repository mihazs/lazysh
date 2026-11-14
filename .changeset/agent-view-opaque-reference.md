---
"@lazysh/client": minor
"@lazysh/agent": minor
---

Resolve the Agent view's Claude Code and Codex conversation on the host companion behind an opaque reference: the companion's reported-history lookup (`reported-history --reference`) answers with a reference it issued instead of the transcript path, and `transcript --reference` and `transcript-watch --reference` read the conversation it names, refusing without reading any file a reference it never issued, an altered, stale or foreign one. The app no longer receives or sends the host transcript path for a bound Agent view conversation; **Choose transcript** keeps its explicit path. Needs the updated host companion: with an older one the Agent view shows the detected agent with its conversation unavailable and asks to update the companion.
