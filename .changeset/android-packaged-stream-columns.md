---
"@lazysh/client": patch
---

fix(bench): match the native and xterm terminal grids in Android stream measurements

The packaged xterm benchmark can match the native arm’s rows and columns using rendered cell dimensions, then checks the remote PTY size before replaying the matched fixture.
