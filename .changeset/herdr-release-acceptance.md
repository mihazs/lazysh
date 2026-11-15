---
"@lazysh/client": patch
---

Accept the managed Herdr derivative beside an unchanged stock server in the Herdr native job: a stock and a managed server of the same session name share one `HOME` and set of XDG roots, the stock server's process, sockets, configuration and workload stay exactly as they were, everything the managed server adds sits in its own `lazysh-herdr` directory, its pane children keep `HOME`, every XDG root and the provider profile, and only the managed executable advertises guarded attachment. The owned acceptance can now run on an executable named by `LAZYSH_TEST_HERDR_MANAGED`, so a retained or downloaded release asset can be accepted instead of a rebuild. Nothing is published, no install or removal is added and no platform support is claimed yet.
