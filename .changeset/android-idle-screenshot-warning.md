---
"@lazysh/agent": patch
---

fix(agent): start the Android video preview on an idle screen of a guest that prints a warning line

Fix the Android video preview never starting on an idle screen of a guest that prints a warning line before its screenshot, such as Waydroid: the screenshots that stand in for a video frame read the PNG without skipping that line, so each was dropped as an invalid image and the stream ended in `DeviceTimeout`. They now read it the way **Capture screen** does.
