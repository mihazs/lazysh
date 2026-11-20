---
"@lazysh/client": minor
"@lazysh/agent": minor
---

feat(devices): touch an Android device on its video preview

With **Enable device input** ticked, a tap or swipe on the video is mapped to the display's pixel size that **Verify Android video tools** reports and sent with that size to the host companion (`lazysh-agent devices android tap` and `swipe`). The companion reads the display size again and refuses the gesture with `DeviceDimensionsChanged` when it changed (a rotation or resize) or the point is outside it, so a gesture never lands on the wrong point; the refusal also stops the video. A 180-degree rotation that keeps the size is not detected. Needs the updated host companion; an older one keeps the video view-only. A real Waydroid Android 13 guest accepted and refused gestures as described; the published CI emulator has not run the new case yet. Changed default: the Android video preview is no longer always view-only.
