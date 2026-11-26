---
"@lazysh/client": patch
---

fix(bench): match the native and xterm terminal grids in Android stream measurements

The packaged xterm benchmark can cap its columns to the native arm and checks the remote PTY size before replaying the matched fixture.
