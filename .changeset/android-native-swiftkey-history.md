---
"@lazysh/client": patch
---

fix(android): restore inline shell history suggestions with SwiftKey in native terminals

The native terminal identifies its text field to Android in the same way as the WebView terminal. SwiftKey can send the first typed character to the shell without requiring Private keyboard mode.
