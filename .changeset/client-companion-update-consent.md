---
"@lazysh/client": minor
---

feat(client): ask once per host before updating a companion that cannot update itself

When the host companion is older than this app and does not update itself (it predates `lazysh-agent auto-update`), the Agents panel asks "Update the host companion to match this app?" with Always, Not now and Never. Always updates it through the host (nothing is downloaded on this device) now and on later connections, Not now asks again next time, Never is remembered. The answer is kept per host and can be set back to Ask me under Host companion settings. Companions that update themselves are never asked, and nothing changes without an answer. English, Brazilian Portuguese and Spanish.
