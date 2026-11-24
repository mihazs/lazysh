---
"@lazysh/client": patch
---

fix(agent): accept Windows profile paths when setting up agent hooks on a Windows device

Fixes #2473. Hook setup refused every provider profile that was not a POSIX path, so a Windows user who passed an absolute profile such as `C:\Users\me\.claude` or a UNC share got "Select an absolute existing provider profile" before the companion could answer. The profile path is now checked with the rules of the host that reads it: Windows drive and UNC paths on this device when it runs Windows (outside WSL), POSIX paths everywhere else. Device namespaces, `.` and `..` segments, control characters and alternate data streams are still refused, and SSH hosts and Unix devices behave as before.
