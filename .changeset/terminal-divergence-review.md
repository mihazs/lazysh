---
"@lazysh/client": patch
---

Settle every open difference between the shared Rust terminal core and xterm.js (#1314, slice 1314b, part of #1302): each entry of the divergence registry now carries a recorded decision and the test that pins it, and tmux, vim, bash, Herdr, Claude Code, Codex and OpenCode run on a pty with the core as their terminal in the core's own tests. The review approves the core's Unicode 11 and later widths (emoji, ZWJ and skin-tone sequences take two cells), the standard Alt+arrow encodings, the Kitty keyboard reports Codex and Herdr ask for, libghostty-vt's device attributes, the OSC 52 selection filter and reflow on resize, and moves Shift+PageUp routing to #1334. The core is not wired into the app and xterm.js stays the only engine and the default, so nothing changes for users; the release notes of the Android default (#2094) must call out the widths, the Alt+arrow form, reflow and the dropped primary-selection writes.
