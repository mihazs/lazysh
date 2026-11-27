---
"@lazysh/client": patch
---

fix(android): preserve typed terminal words when SwiftKey inserts a space

The native terminal keeps the existing shell text when SwiftKey automatically corrects an already typed word. Explicit keyboard suggestions and composing text still work.
