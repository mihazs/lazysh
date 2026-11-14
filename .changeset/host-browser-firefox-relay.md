---
"@lazysh/agent": minor
---

Teach the host browser relay (`lazysh-agent host-browser serve`) to stream Firefox 159 or newer over WebDriver BiDi: a private profile, `--no-remote`, a random loopback port used only by the relay (the exact `Host` Firefox requires and no `Origin`), polled and pipelined JPEG screenshots that skip repeats, the page's title and address as text, a closed allow-list for every BiDi command, and a session that is always ended and, when Firefox already holds one, replaced by a Firefox the relay starts. A headless Firefox started this way writes no download, and its profile blocks permission prompts and turns off telemetry and update checks. The command is hidden and the app has no viewer yet; input, tabs, navigation and the adaptive frame rate for Firefox follow the matching Chrome slices.
