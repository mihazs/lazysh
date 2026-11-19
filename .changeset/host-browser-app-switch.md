---
"@lazysh/client": minor
---

Add the Host browser switch to host settings: a separate row, off by default, that reads and saves the companion's `settings host-browser` setting with its own revision, and asks once per host on this device, naming what the browser can reach, before it is turned on. The confirmation stays on the device and never enters the encrypted sync. A companion without the command shows the row as unavailable with an update message. The browser view itself ships with the Chrome viewer.
