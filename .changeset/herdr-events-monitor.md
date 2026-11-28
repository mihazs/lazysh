---
"@lazysh/client": minor
---

feat(herdr): keep the Herdr event stream open for the inbox while no Herdr view is shown

With Monitor connected hosts on, each connected host that runs one Herdr server (or the attached one) is followed through the shared stream a visible Herdr view reads, so a blocked or finished Herdr agent becomes an inbox event and a notification whichever page is open. It is deduplicated against the same turn reported by a hook, and the stream closes when monitoring is turned off or the host disconnects.
