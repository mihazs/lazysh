---
"@lazysh/client": patch
---

test(agents): verify the All hosts Agents board of two owned SSH hosts in the Linux GUI

The Linux GUI suite now connects two owned SSH hosts with real companion hook events and checks the All hosts scope: reports by state, then host, then project, one host's error row beside the other host's rows, and a row opening its host's connection. Test and documentation only; no user-visible behaviour changes.
