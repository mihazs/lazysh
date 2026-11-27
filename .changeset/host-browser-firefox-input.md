---
"@lazysh/agent": minor
---

feat(browser): let the host browser relay's Firefox take pointer, wheel, key and text input

After Control is turned on, `lazysh-agent host-browser serve` maps the same pointer, wheel, key and text messages as Chrome, with the same bounds, refusals and rate limit, to WebDriver BiDi `input.performActions` through a closed, bounded allow-list. A rejected sequence is released, and the capability record says Firefox has no page pinch and no composition. The command is hidden and the app has no viewer yet.
