---
"@lazysh/client": patch
---

fix(chat): keep every character typed quickly into the transcript path field

A long path entered in one burst, such as native key events, could lose a character once React hit its nested-update limit. The path field's resets now leave no update pending after each keystroke.
