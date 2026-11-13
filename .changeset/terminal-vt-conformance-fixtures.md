---
"@lazysh/client": patch
---

Compare the native terminal engine with xterm.js: 91 replayable screens (colours, cursor, editing, Unicode, alternate screen, modes, paste, resize, captures of vim, less, tmux, Claude Code, Codex, OpenCode, Zellij and Herdr, and the six captured Mosh frames), 75 key presses and 130 mouse reports run through xterm.js 5.5.0 and through the Rust core, with 28 differences recorded and explained. The comparison also fixed a defect in the core's mouse reporting: under any-event tracking a resting pointer sent a report for every pointer event in one cell, where xterm.js sends one. The core is not wired in as an engine you can choose yet, so nothing changes in the app; xterm.js stays the terminal engine.
