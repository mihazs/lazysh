---
"@lazysh/client": patch
---

fix(android): keep native terminal keyboard edits on the active input connection

Keep the keyboard's text snapshot in sync after a batch, reject edits from retired connections, and apply Android's explicit text corrections to the native terminal editor. Backspace stays visible when SwiftKey reopens the last word for composition.
