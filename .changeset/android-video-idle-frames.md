---
"@lazysh/agent": patch
---

Show an idle Android screen in the video preview. The video stream sends a screenshot first, which counts as the first frame, and another whenever no video frame has come for a second (at most one a second), so an idle device no longer stops at the ten-second startup limit and the last frame of a change is replaced. Needs the updated host companion. No defaults change.
