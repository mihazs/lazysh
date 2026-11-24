---
"@lazysh/client": patch
---

fix(terminal): open the soft keyboard on the native terminal, let page fields keep it and make the toolbar modifiers work

On a session using the native terminal engine, the soft keyboard now opens when the terminal takes focus or receives a plain tap (the request waits until Android has made the terminal's keyboard editor the active one), a field of the page (the agent composer, a dialog, the search box) takes the keys instead of the terminal while it has focus, and the terminal gets them back when it asks again. The keyboard editor also tells keyboards such as SwiftKey the text around the caret up front. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.

The toolbar's Ctrl, Alt and Shift buttons now work on the native terminal: they apply to the next character the soft keyboard types, as with xterm.js. Every toolbar key writes the same bytes as the xterm.js pane does, alone and under each modifier.
