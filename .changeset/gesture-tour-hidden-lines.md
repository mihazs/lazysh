---
"@lazysh/client": patch
---

fix(onboarding): make the gesture tour match the hidden gesture lines

The tour no longer draws a handle line or tells you to start from one while Show gesture lines is off, which is the default. On Android gesture navigation it now says to start in the strip just inside the system's zone, and where to turn the lines on.
