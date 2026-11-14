---
"@lazysh/client": patch
---

Send what the shared Rust terminal core encodes, keys, mouse reports, bracketed paste, focus events and its answers to terminal queries, to the SSH, Mosh, Eternal Terminal or local terminal as bytes, under the same access checks as typed input. The core is not wired to a renderer or offered as a setting, and xterm.js stays the only engine and the default, so nothing changes for users; this is groundwork for trying a native engine behind an explicit opt-in.
