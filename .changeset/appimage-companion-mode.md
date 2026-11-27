---
"@lazysh/client": patch
---

fix(release): keep the bundled companion executable in the restored Linux AppImage

The restored AppImage installed the published companion with the mode of its downloaded artifact, so the release check found it not executable.
