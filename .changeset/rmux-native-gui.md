---
"@lazysh/client": patch
---

Add the Linux native GUI case for rmux: the real bundled app attaches an rmux 0.10.0 session from the Sessions panel over owned OpenSSH, switches windows with Jump To and closes the tab, and the session and its pane shells survive with no client attached. Test-only; the owned SSH fixture gains an rmux mode and `native-linux` installs the same pinned rmux release as `native-linux-runtimes`.
