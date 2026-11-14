---
"@lazysh/client": patch
---

Teach the shared Rust terminal core to bring a reader who scrolled back into history to the live screen when typing or pasting is accepted, like xterm.js's `scrollOnUserInput`, so the reply to a key pressed from scrollback (a toolbar Enter confirming an agent menu) is never left out of view. The core is not wired into the app yet and xterm.js stays the only engine and the default, so nothing changes for users; this is groundwork for trying a native engine behind an explicit opt-in.
