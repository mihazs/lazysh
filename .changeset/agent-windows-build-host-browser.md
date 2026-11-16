---
"@lazysh/agent": patch
---

Build the Windows companion again: the host browser relay's stand-in for Windows (which has no pipe transport) returned a tuple while its caller expected the relay's pipe struct, so `lazysh-agent` did not compile for Windows and no release could be verified. One function signature now serves every platform, so the two cannot drift. Windows hosts still report the host browser as unsupported. The Android idle-frame tests no longer parse a frame that is still being written.
