---
"@lazysh/agent": minor
---

feat(browser): navigate, go back and forward, reload and switch tabs in the host Firefox relay

The Firefox adapter of the host browser relay (`lazysh-agent host-browser serve`) now answers `navigate`, `back`, `forward`, `reload`, `tabs`, `activateTab`, `newTab` and `closeTab` through WebDriver BiDi, and reports `navigation` and `tabs` as true. A page that Firefox lists as opened by the shown one (a popup) becomes a tab and takes the view, only the shown tab streams, titles are one `document.title` read each, and a page beyond sixteen is closed again. An address that is not `http`, `https` or `about:blank` is refused before Firefox is asked (Firefox 160 opens `file:` itself), and so is a tab the relay never listed. Firefox has no command to stop a load, so `stop` is refused and the capability record says `stop: false`. The command is still hidden and the app does not send these messages yet.
