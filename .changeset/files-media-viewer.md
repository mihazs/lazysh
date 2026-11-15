---
"@lazysh/client": minor
---

View video and audio in Files in an isolated frame with no script rights and no access to the app or its native bridge. The native reader checks the file's type from its first bytes and refuses a mislabeled, oversized (over 8 MiB) or linked file; a PDF is opened in the device's PDF viewer instead of drawn in the app; on Linux the preview needs GStreamer's audio plugins and says so when they are missing. The content security policy allows `data:` in `media-src`.
