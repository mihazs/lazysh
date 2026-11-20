---
"@lazysh/client": patch
---

feat(terminal): add the typed-input editor for native terminal sessions on desktop and iOS

First slice of #1334: a hidden text field in the terminal's container that takes keys, input-method composition and paste. Keys go to the core as DOM-shaped key inputs after the platform rules for Option and AltGr; Shift+PageUp and Shift+PageDown scroll the history by a page and are not sent to the program, as with xterm.js; composition shows its preedit at the cursor and commits once whichever order the browser fires its events in; a paste is bracketed for a program that asked for it. Android keeps its native input connection and gets no editor. No release build selects the native terminal, so xterm.js stays the default and nothing changes for users.
