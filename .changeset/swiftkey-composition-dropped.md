---
"@lazysh/client": patch
---

Fix typing stopping in the terminal with the SwiftKey keyboard until Backspace was pressed (#1505): the terminal now notices that Android's WebView dropped a composition the keyboard erased whole, instead of waiting for an end that never comes and holding back every key after it.
