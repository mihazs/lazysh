---
"@lazysh/client": minor
---

Changed default: the Agent view reads its history by scrolling, up and down, instead of the Load earlier messages and Load later messages buttons. The next page is read when an end comes within about a screen and a half, one at a time, with a spinner at that end, Start of the session and End of the session so far markers and a Retry row for a failed page; the line being read stays put. The buttons stay for screen readers, the keyboard and web views without IntersectionObserver.
