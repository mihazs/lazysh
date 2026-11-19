---
"@lazysh/client": patch
---

test(android): run the real terminal core inside the app on the CI emulator

A new `native-android-terminal-core` job builds the app with the optional `native-terminal` feature for arm64 (compiled and linked) and x86_64 and prints the size of each library, and an instrumentation case opens a core through the renderer's IPC, connects to an owned OpenSSH and reads back the shell's output with `terminal_core_text` on the CI emulator. The same harness runs against the Waydroid guest once its session can start. The feature stays off in every release build, so the app, its settings and its defaults are unchanged and nothing changes for users.
