---
"@lazysh/client": patch
---

Fix moving between Herdr terminals opening the Android soft keyboard and shrinking the terminal: on touch screens no navigation focuses a terminal input any more, and a keyboard that is already open passes to the terminal you move to without closing.
