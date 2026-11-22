---
"@lazysh/agent": minor
"@lazysh/client": minor
---

feat(usage): add host switches for simulator streaming and port scanning in their own host-features.json

Add host feature switches in their own `host-features.json`: `lazysh-agent settings features show|update` controls whether `devices ... stream` is allowed (it fails with `SimulatorStreamingDisabled` before any SDK process) and whether the app's port scanning is allowed; the Preview panel reads the port-scan switch before every discovery and says when the host turned it off, and Host companion settings offers both switches with a conflict-safe save. `settings.json` is unchanged, so an older companion keeps working. Changed default: the Preview panel now remembers the HTTP check and the automatic refresh for each saved host instead of resetting them on every visit.
