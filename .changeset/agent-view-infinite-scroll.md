---
"@lazysh/client": minor
---

feat(agents): read the Agent view history by scrolling, up and down, instead of Load earlier and Load later buttons

Changed default: the next page is read when an end comes within about a screen and a half, one at a time, with a spinner at that end, Start of the session and End of the session so far markers and a Retry row for a failed page; the line being read stays put. Jump to start now sits next to Jump to latest. The two load buttons stay for screen readers, the keyboard and web views without IntersectionObserver.
