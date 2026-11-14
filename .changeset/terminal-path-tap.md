---
"@lazysh/client": patch
---

Fix tapping a host file path printed in the terminal doing nothing on a touch screen: a tap now reads the path under the finger, asks the host whether the file exists and opens its sheet, as a mouse click does.
