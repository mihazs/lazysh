---
"@lazysh/agent": minor
---

Add the host browser relay, `lazysh-agent host-browser serve`: on one SSH exec channel it starts a private, headless Chrome or Chromium with `--remote-debugging-pipe` (no port on the host), streams the page as length-prefixed JPEG frames with the page's title and address, paces them by the device's acknowledgements and pauses at the browser when the view is hidden. Every protocol command passes the allow-list, a client message outside the closed set is refused and counted, and the browser, its helpers and its profile end with the channel. It fails before it starts anything while the host browser switch (off by default) is off. The command is hidden and nothing in the app uses it yet: the viewer ships in a later slice of the same feature.
