---
"@lazysh/client": patch
---

Draw the Agent view's folded tool activity only when it is opened: a 100-message conversation puts about 400 elements in the page instead of about 1,500 and costs about 40 % less main-thread script at 4x CPU slowdown.
