---
"@lazysh/client": minor
"@lazysh/agent": minor
---

Touch the Android device on its video preview. With **Enable device input** ticked, a tap or swipe on the video is mapped to the display's pixel size that **Verify Android video tools** reports and sent with that size to the host companion, which refuses the gesture (`DeviceDimensionsChanged`) when the display no longer has that size, so a rotation or resize never lands a touch on the wrong point; the refusal also stops the video. Needs the updated host companion; an older one keeps the video view-only. Also fix **Verify Android video tools** failing on current platform-tools, which list adb features one per line. No defaults change.
