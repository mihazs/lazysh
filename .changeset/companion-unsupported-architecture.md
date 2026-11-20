---
"@lazysh/client": patch
---

feat(companion): explain where the host companion is installed and what is verified before it starts

Agents now says where the companion goes, what the host verifies and that nothing changes until the button is pressed. An unsupported host architecture is covered by an owned OpenSSH test (both routes refuse it before anything is fetched or written). Installation behaviour is unchanged.
