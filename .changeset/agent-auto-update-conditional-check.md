---
"@lazysh/agent": patch
---

Make the scheduled companion update check conditional. After a check that read a release listing, the next one sends its ETag as `If-None-Match`; while GitHub answers `304 Not Modified` the check is one small request that costs no API rate limit, keeps the version it found and decides again whether it is newer than the installed companion. A changed listing, another channel or an ETag that is not a well formed entity tag is checked and verified in full as before, and an install never relies on a `304`. The ETag is kept in `update-state.json` as `releaseEtag`, outside `lastCheck`.
