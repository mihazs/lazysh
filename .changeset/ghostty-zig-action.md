---
"@lazysh/client": patch
---

build(ci): provision Zig and the Ghostty archives through one composite action

The checksum-verified Zig 0.16.0 and the admitted libghostty-vt archives are set up by a single `ghostty-zig` composite action instead of copied workflow steps, so the Android release build can use the same provisioning. CI behaviour is unchanged and nothing changes for users.
