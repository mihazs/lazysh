---
"@lazysh/client": patch
---

fix(companion): never run a symbolic link in the managed directory as the local companion on macOS

Refs #2450. The local companion lookup trusts a managed copy only when it is the user's own file, not a link, writable by nobody else, but it checked the owner and the write bits and never the file type. A link has mode 0777 on Linux, which the write check rejected by accident, and 0755 on macOS, which it accepted, so a link there could make the app run another file as its companion. A link is now refused by its type on every platform. No default changes.
