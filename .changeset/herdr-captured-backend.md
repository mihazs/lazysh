---
"@lazysh/client": patch
---

feat(herdr): run every native Herdr call on the one Herdr a connection captured, nothing changes for users yet

Make every native Herdr call run one Herdr that the connection captured once: the host's own `herdr` or the optional managed derivative at its fixed path `~/.local/libexec/lazysh-herdr/herdr`. Discovery, the session list, the tree and its actions, workspace creation, SSH and Mosh attachment, the guard's capability check and RPCs, and the display's owning actor all use the captured choice; a different second choice is refused, a missing or untrusted managed file never falls back to the host's own Herdr, and the choice is a closed name, never a path or command. Nothing installs the managed Herdr and the app offers no choice yet, so behaviour and defaults are unchanged.
