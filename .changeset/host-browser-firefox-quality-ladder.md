---
"@lazysh/agent": minor
---

feat(browser): fit the host Firefox relay's polling and encoding to the link with the quality ladder

The host browser relay (`lazysh-agent host-browser serve`, hidden, off until the host browser switch is on) now drives a managed Firefox from the same four-rung quality ladder as Chrome: the rung sets the capture's JPEG quality, how often Firefox is asked for a screenshot (every 50 ms at most, every 100 ms at the lowest rung) and the frame size (the page's device pixel ratio). It steps down within a second when the device acknowledges too few frames and up after ten stable seconds, and `quality {rung}` and Data saver hold a rung. A frame that repeats the last one does not count as produced. The two-second boost after input and the sharp still for a page that stopped changing are not done yet. The measured CPU cost per rung is in the feasibility document.
