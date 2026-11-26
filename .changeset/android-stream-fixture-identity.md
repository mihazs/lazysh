---
"@lazysh/client": patch
---

fix(bench): compare Android terminal streams only when their grids and bytes match

The xterm benchmark can replay the native arm’s grid from a same-run receipt. The runner and comparator verify the fixture hashes and dimensions for W2–W4.
