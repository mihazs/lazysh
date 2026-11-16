---
"@lazysh/client": patch
---

feat(desktop): find native Zellij and Herdr on Windows through PATHEXT in discovery and actions

Find a native Zellij or Herdr on Windows the same way in multiplexer discovery, one-shot actions and attach. Discovery and actions only appended `.exe` to the program name, so a Zellij or Herdr installed as a `.com` file, or found through a different `PATHEXT` order, was reported missing or failed to start while attach found it. They now try each `PATH` directory in order with the name plus the `.com` and `.exe` entries of `PATHEXT`, and an action runs the file found; a `.bat` or `.cmd` still never resolves. Herdr is looked up on the `PATH` only on Windows. A program that resolved before still resolves, and Linux and macOS behave as before.
