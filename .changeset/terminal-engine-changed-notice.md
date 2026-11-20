---
"@lazysh/client": minor
---

feat(terminal): add the one-time notice that the terminal engine changed and where to switch back

When the terminal engine that Automatic selects on this device differs from the one the device last used by default, the app shows a notice above the session tabs: "The terminal engine changed on this platform. Switch back in Settings, Terminal engine." It has an Open Settings button and a Dismiss button, stays until one of them is pressed and then does not return. It is not shown on a fresh install or to anyone who chose an engine in Settings, and that choice is not reset. In English, Brazilian Portuguese and Spanish. No default changes in this release: sessions still use xterm.js, so the notice does not appear yet.
