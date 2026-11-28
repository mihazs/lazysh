---
"@lazysh/agent": patch
"@lazysh/client": patch
---

fix(agent): keep hook setup working after a profile folder is restored, copied or remounted

Inspecting a hook profile failed with `HooksForeignRecord: operation failed` once the profile directory's device or inode changed, for example after a reboot on btrfs, so hooks could be neither updated nor removed. The setup record now stays bound to the agent and profile path, and the plan still refuses a directory swapped before apply. A record written for another folder is reported as unsupported with a specific explanation instead of an error, and every other hook setup failure shows a fixed, localized message instead of the companion's internal error name.
