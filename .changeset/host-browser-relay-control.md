---
"@lazysh/agent": patch
---

Teach the host browser relay (`lazysh-agent host-browser serve`) the Control switch and the input messages: `control {on}` turns Control on or off for the session (off at every start), and while it is on `pointer`, `wheel`, `pinch`, `key` and `text` become the browser's mouse, wheel, page-scale, key and insert-text calls, in the order sent, through the allow-list. While Control is off each input message is refused and counted, never forwarded. A value outside its bounds, a clipboard shortcut, an unknown field and a flood of more than 240 messages a second are refused with a counted reason. The command is still hidden and nothing in the app sends these messages yet.
