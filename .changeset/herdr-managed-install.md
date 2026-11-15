---
"@lazysh/client": minor
---

Add the explicit install and removal of the optional managed Herdr over the connected SSH session: a collapsed **Managed Herdr on this host** section in the Multiplexer workspaces panel with **Install** and **Remove**. Install uploads the verified release file for the host's own platform, has the host check its size, digest and CPU and refuse a stale plan, an unsafe destination or an executable that does not run, and publishes it as `<data>/lazysh/herdr/lazysh-herdr` by one rename; removal deletes only that file. The system Herdr, its configuration, running servers and sessions are never touched. The release set lists no managed Herdr yet, so the install stops with a clear message until it is published; no release or platform support is claimed.
