---
"@lazysh/client": patch
---

feat(terminal): honor Linux desktop accessibility in the terminal

When AT-SPI reports accessibility enabled, new sessions use xterm.js with screen-reader announcements on.
