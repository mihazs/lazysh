---
"@lazysh/client": minor
---

feat(browser): add a view-only Host browser tool that shows the host's Chrome beside Preview

The tool is offered only for a host whose Host browser switch is on and that this device confirmed, and it is off until then. It draws the host's page on a canvas, shows the page's title and address as plain text, names whether it is starting, live, paused, closed or failed with the reason the host or the app gives (English, Portuguese and Spanish), and pauses within a second when the tool is not shown, the app is in the background or the screen is off. It opens a blank page and takes no input yet; the address bar and touch and keyboard control are separate slices.
