---
"@lazysh/client": minor
---

feat(files): play video and audio in an isolated frame

Files now plays video and audio in a frame with no script rights and no access to the app or its native bridge. The native reader checks the file's type from its first bytes and refuses a mislabeled, oversized (over 8 MiB) or linked file. A PDF is opened in the device's PDF viewer instead of drawn in the app. On Linux the preview needs GStreamer's audio plugins and says so when they are missing. Changed default: the content security policy allows `data:` in `media-src`.
